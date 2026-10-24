// Envia o áudio, em partes, para o mini servidor (Cloudflare Worker) que usa o Gemini e junta o texto.

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

async function sendPart(url, wav, { language, key }) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${url}?lang=${encodeURIComponent(language || "")}`, {
        method: "POST", body: wav, headers: { "Content-Type": "audio/wav", "X-Access-Key": key || "" },
      });
      if (r.status === 401) throw new NeedKey("Código de acesso incorreto.");
      const j = await r.json().catch(() => ({}));
      if (r.ok) return (j.text || "").trim();
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

export async function transcribeWithGemini(audio, { url, language, key, onProgress = () => {} }) {
  const parts = splitPoints(audio), texts = [];
  for (let i = 0; i < parts.length; i++) {
    onProgress(i, parts.length);
    const wav = toWav(audio.subarray(parts[i][0], parts[i][1]));
    const t = await sendPart(url, wav, { language, key });
    if (t) texts.push(t);
  }
  onProgress(parts.length, parts.length);
  return texts.join("\n\n");
}
