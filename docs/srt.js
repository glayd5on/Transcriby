// Geração de SRT e de texto corrido a partir dos trechos: [{start, end, text, paragraph}]

const MAX_LINE = 42;
const MAX_PARAGRAPH = 900;   // parágrafo sem quebra marcada é cortado no fim de frase depois disso

export function ts(sec) {
  let ms = Math.round(Math.max(sec, 0) * 1000);
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
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

export function toSrt(segments) {
  return cues(segments, groupLines);
}

/** Texto corrido, em parágrafos: usa a quebra marcada pelo modelo e corta parágrafos longos no fim de uma frase. */
export function toPrettyText(segments) {
  const paras = []; let cur = "";
  for (const s of segments) {
    const t = s.text.replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (cur && (s.paragraph || (cur.length >= MAX_PARAGRAPH && /[.!?…]$/.test(cur)))) { paras.push(cur); cur = ""; }
    cur = cur ? cur + " " + t : t;
  }
  if (cur) paras.push(cur);
  return paras.join("\n\n") + "\n";
}
