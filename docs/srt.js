// Geração de SRT/TXT a partir dos trechos do Whisper: [{start, end, text}]

const CAPCUT_MAX_CHARS = 24;
const MAX_LINE = 42;

export function ts(sec) {
  let ms = Math.round(Math.max(sec, 0) * 1000);
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

export function stripPunct(text) {
  return text
    .replace(/(?<!\d)[,.](?!\d)/g, " ")                 // mantém 3,5 e 1.000
    .replace(/[!?;:…—–"'“”‘’()\[\]{}«»]+/g, " ")
    .replace(/(?<!\w)-|-(?!\w)/g, " ")                   // hífen solto
    .replace(/\s+/g, " ").trim();
}

function chunkWords(words, max) {
  const out = []; let cur = [];
  for (const w of words) {
    if (cur.length && (cur.join(" ") + " " + w).length > max) { out.push(cur.join(" ")); cur = []; }
    cur.push(w);
  }
  if (cur.length) out.push(cur.join(" "));
  return out;
}

function wrapLines(text, width) {
  const lines = []; let cur = "";
  for (const w of text.split(/\s+/)) {
    if (cur && (cur + " " + w).length > width) { lines.push(cur); cur = w; } else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

function cues(segments, makeChunks) {
  const out = [];
  for (const seg of segments) {
    const chunks = makeChunks(seg.text.trim());
    if (!chunks.length) continue;
    const total = chunks.reduce((a, c) => a + c.length, 0);
    let t = seg.start;
    for (const c of chunks) {
      const dur = (seg.end - seg.start) * c.length / total;
      out.push([t, t + dur, c]); t += dur;
    }
  }
  return out.map(([a, b, c], i) => `${i + 1}\n${ts(a)} --> ${ts(b)}\n${c}\n`).join("\n");
}

// Quebra em até 2 linhas, equilibrando o tamanho das duas (evita uma palavra sozinha na segunda linha).
function wrapTwoLines(text) {
  if (text.length <= MAX_LINE) return [text];
  const words = text.split(" ");
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
    if (a.length > MAX_LINE || b.length > MAX_LINE) continue;
    const diff = Math.abs(a.length - b.length);
    if (!best || diff < best.diff) best = { diff, lines: [a, b] };
  }
  return best ? best.lines : wrapLines(text, MAX_LINE);
}

// Divide o trecho em legendas de até 2 linhas e de tamanhos parecidos (sem deixar uma palavra sozinha numa legenda).
function groupLines(text) {
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const k = Math.ceil(wrapLines(text, MAX_LINE).length / 2);
  if (k <= 1) return [wrapTwoLines(text).join("\n")];
  const words = text.split(" "), target = text.length / k, parts = [];
  let cur = [];
  for (const w of words) {
    const len = cur.join(" ").length;
    if (cur.length && parts.length < k - 1 && len + 1 + w.length / 2 > target) { parts.push(cur); cur = []; }
    cur.push(w);
  }
  parts.push(cur);
  const groups = parts.map(p => wrapTwoLines(p.join(" ")));
  if (groups.length !== k || groups.some(g => g.length > 2)) {  // plano B: o jeito antigo
    const lines = wrapLines(text, MAX_LINE), out = [];
    for (let i = 0; i < lines.length; i += 2) out.push(lines.slice(i, i + 2).join("\n"));
    return out;
  }
  return groups.map(g => g.join("\n"));
}

/** style: "capcut" (curto, sem pontuação) ou "completo" (com pontuação, 2 linhas) */
export function toSrt(segments, style) {
  if (style === "capcut") return cues(segments, t => chunkWords(stripPunct(t).split(" ").filter(Boolean), CAPCUT_MAX_CHARS));
  return cues(segments, groupLines);
}

export function toTxt(segments, style) {
  const all = segments.map(s => s.text.trim()).join(" ");
  if (style === "capcut") return stripPunct(all) + "\n";
  // parágrafos: nova quebra após pausa longa ou ~700 caracteres, sempre no fim de frase
  const paras = []; let cur = "", lastEnd = null;
  for (const s of segments) {
    const gap = lastEnd === null ? 0 : s.start - lastEnd;
    if (cur && /[.!?]$/.test(cur.trim()) && (gap >= 1.5 || cur.length >= 700)) { paras.push(cur.trim()); cur = ""; }
    cur += s.text.trim() + " "; lastEnd = s.end;
  }
  if (cur.trim()) paras.push(cur.trim());
  return paras.join("\n\n") + "\n";
}

// Limpa o "lixo" típico do Whisper: letras de outros alfabetos (coreano, chinês, russo…), frases repetidas em loop
// e palavras repetidas dezenas de vezes. Só mexe nos alfabetos quando o idioma foi escolhido (não é "detectar").
const FOREIGN = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}\p{Script=Hebrew}\p{Script=Devanagari}]/gu;

export function cleanSegments(segments, language) {
  const out = []; let lastKey = "", run = 0, removed = 0;
  for (const seg of segments) {
    let t = seg.text;
    if (language) t = t.replace(FOREIGN, " ");
    t = t.replace(/\b([\p{L}\d]+)(?:[\s,.!?]+\1\b){3,}/giu, "$1");   // "sim sim sim sim sim" -> "sim"
    t = t.replace(/\s+/g, " ").trim();
    const key = stripPunct(t).toLowerCase();
    if (key.replace(/[^\p{L}\d]/gu, "").length < 2) { removed++; continue; }
    if (key === lastKey) { run++; if (run >= 1) { removed++; continue; } } else { run = 0; lastKey = key; }
    out.push({ ...seg, text: " " + t });
  }
  return { segments: out, removed };
}
