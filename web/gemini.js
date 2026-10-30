// Envia o áudio, em partes, para o mini servidor (Cloudflare Worker) que usa o Gemini e junta os trechos com tempo.
// Também pede o resumo de um texto pronto.

const RATE = 16000;
const CHUNK_SECONDS = 300;     // partes de ~5 minutos (cada WAV fica com ~9,6 MB)
const SEARCH_SECONDS = 8;      // procura um silêncio até 8 s antes do corte para não partir palavras

/** Divide em partes de ~5 min, cortando no ponto mais silencioso perto do limite. Devolve [[início, fim], ...] em amostras. */
export function splitPoints(audio, chunkSec = CHUNK_SECONDS, searchSec = SEARCH_SECONDS) {
  const chunk = chunkSec * RATE, search = searchSec * RATE, win = Math.round(RATE * 0.05);
  const parts = []; let start = 0;
  while (audio.length - start > chunk + search) {
    const from = start + chunk - search, to = start + chunk;
    let best = to, bestE = Infinity;
    for (let p = from; p + win <= to; p += win) {
      let e = 0; for (let i = p; i < p + win; i++) e += audio[i] * audio[i];
      if (e < bestE) { bestE = e; best = p + (win >> 1); }
    }
    parts.push([start, best]); start = best;
  }
  parts.push([start, audio.length]);
  return parts;
}

/** Float32 mono 16 kHz -> WAV PCM 16 bits */
export function toWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

export class NeedKey extends Error {}

/** "MM:SS", "H:MM:SS" ou segundos soltos -> segundos (ou null se não der para ler). */
export function parseTime(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const p = String(v ?? "").trim().replace(",", ".").split(":");
  if (!p[0] || p.length > 3 || p.some(x => !/^\d+(\.\d+)?$/.test(x))) return null;
  return p.reduce((acc, x) => acc * 60 + parseFloat(x), 0);
}

const CHARS_PER_SEC = 8;   // ritmo mínimo de leitura da legenda: evita esticar um trecho por cima de um silêncio longo

/**
 * Trechos de uma parte -> [{ start, end, text, paragraph }] com tempo contado desde o início do arquivo.
 * O Gemini só informa o começo de cada trecho; o fim é o começo do próximo (limitado pelo tamanho do texto).
 */
export function placeSegments(raw, offset, partSeconds) {
  const segs = []; let lastStart = 0;
  for (const r of raw) {
    const t = parseTime(r.start);
    // tempo ilegível ou fora da parte: assume que vem logo depois do trecho anterior
    const start = t === null || t > partSeconds ? lastStart : Math.max(t, lastStart);
    segs.push({ start, text: r.text, paragraph: !!r.paragraph }); lastStart = start;
  }
  return segs.map((s, i) => {
    const next = i + 1 < segs.length ? segs[i + 1].start : partSeconds;
    const est = s.start + Math.max(2, s.text.length / CHARS_PER_SEC);
    const end = next - s.start >= 0.5 ? Math.min(next, est) : est;   // tempo repetido ou ilegível: usa a estimativa
    return { start: offset + s.start, end: offset + Math.min(end, partSeconds), text: s.text, paragraph: s.paragraph };
  });
}

async function post(url, body, headers, key) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { method: "POST", body, headers: { ...headers, "X-Access-Key": key || "" } });
      if (r.status === 401) throw new NeedKey("Código de acesso incorreto.");
      const j = await r.json().catch(() => ({}));
      if (r.ok) return j;
      last = new Error(j.error || `o servidor respondeu ${r.status}`);
      if (r.status >= 400 && r.status < 500 && r.status !== 429) throw last;
    } catch (e) {
      if (e instanceof NeedKey) throw e;
      last = e;
    }
    await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
  }
  throw last;
}

/** Transcreve em partes e devolve os trechos [{ start, end, text, paragraph }] do arquivo inteiro. */
export async function transcribeWithGemini(audio, { url, language, key, onProgress = () => {} }) {
  const parts = splitPoints(audio), all = [];
  for (let i = 0; i < parts.length; i++) {
    onProgress(i, parts.length);
    const [a, b] = parts[i];
    const j = await post(`${url}?lang=${encodeURIComponent(language || "")}`, toWav(audio.subarray(a, b)), { "Content-Type": "audio/wav" }, key);
    const segs = placeSegments(j.segments || [], a / RATE, (b - a) / RATE);
    if (segs.length) segs[0].paragraph = true;   // cada parte começa um parágrafo (o corte é feito num silêncio)
    all.push(...segs);
  }
  onProgress(parts.length, parts.length);
  return all;
}

/** Pede ao servidor um resumo do texto. size: "curto" ou "completo". */
export async function summarize(text, { url, language, size, key }) {
  const j = await post(`${url}?mode=summary`, JSON.stringify({ text, lang: language || "", size }), { "Content-Type": "application/json" }, key);
  return (j.summary || "").trim();
}
