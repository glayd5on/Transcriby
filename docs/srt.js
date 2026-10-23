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

/** style: "capcut" (curto, sem pontuação) ou "completo" (com pontuação, 2 linhas) */
export function toSrt(segments, style) {
  if (style === "capcut") return cues(segments, t => chunkWords(stripPunct(t).split(" ").filter(Boolean), CAPCUT_MAX_CHARS));
  return cues(segments, t => {
    const lines = wrapLines(t, MAX_LINE), groups = [];
    for (let i = 0; i < lines.length; i += 2) groups.push(lines.slice(i, i + 2).join("\n"));
    return groups;
  });
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
