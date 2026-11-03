// Conversa exportada do WhatsApp: leitura do arquivo de texto (iPhone e Android), ligação das mídias,
// montagem das linhas, filtros e exportação em .md. Tudo aqui é puro (sem rede e sem navegador).
// Data, hora e remetente vêm SEMPRE do arquivo de texto, nunca do modelo de IA.

// Marcas invisíveis que o WhatsApp põe no começo das linhas, e espaços "estranhos" (U+202F antes de AM/PM).
const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;
const clean = (s) => s.replace(INVISIBLE, "").replace(/[   ]/g, " ");

const DATE = String.raw`(\d{1,4})[\/.\-](\d{1,2})[\/.\-](\d{1,4})`;
const TIME = String.raw`(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s?([AaPp])\.?\s?[Mm]\.?)?`;
// iPhone:  [15/10/2026 14:32:05] João: texto        Android:  15/10/2026 14:32 - João: texto
const IOS = new RegExp(`^\\[${DATE},?\\s+${TIME}\\]\\s?(.*)$`);
const ANDROID = new RegExp(`^${DATE},?\\s+(?:às\\s+|as\\s+|a las\\s+|at\\s+)?${TIME}\\s+[-–—]\\s+(.*)$`, "i");

export const TYPE_LABEL = {
  texto: "texto", audio: "áudio", video: "vídeo", imagem: "imagem",
  documento: "documento", figurinha: "figurinha", contato: "contato", outro: "outro", sistema: "sistema",
};
export const SYSTEM_SENDER = "WhatsApp";

const AUDIO_EXT = ["opus", "ogg", "oga", "m4a", "mp3", "aac", "amr", "wav", "caf", "flac"];
const VIDEO_EXT = ["mp4", "mov", "3gp", "mkv", "webm", "avi", "m4v"];
const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "heic", "heif", "gif", "bmp"];

const nfc = (s) => s.normalize("NFC");
export const baseName = (p) => nfc(String(p).split(/[\\/]/).pop());
export const extOf = (name) => ((String(name).match(/\.([A-Za-z0-9]+)$/) || [])[1] || "").toLowerCase();

/** Tipo do anexo pelo nome/extensão do arquivo. */
export function kindFromName(name) {
  const ext = extOf(name);
  if (/(^|[-_ ])(STK|STICKER)([-_ .]|$)/i.test(name)) return "figurinha";
  if (ext === "vcf") return "contato";
  if (AUDIO_EXT.includes(ext)) return "audio";
  if (VIDEO_EXT.includes(ext)) return "video";
  if (IMAGE_EXT.includes(ext)) return "imagem";
  return ext ? "documento" : "outro";
}

const ATTACH_IOS = /^<\s*(?:anexo|attached|adjunto|allegato|anhang|pi[eè]ce jointe)\s*:\s*(.+?)\s*>$/i;
const ATTACH_ANDROID = /^(.+?)\s+\((?:arquivo anexado|file attached|archivo adjunto|fichier joint|datei angeh[äa]ngt|file allegato)\)\s*$/i;
const OMITTED = /^<?\s*(?:m[ií]dia oculta|m[ií]dia omitida|media omitted|multimedia omitido|(?:imagem|image|imagen|v[ií]deo|video|[aá]udio|audio|figurinha|sticker|documento|document|gif|contato|contact card)\s+(?:omitid[oa]|omitted))\s*>?\.?$/i;

function detectAttachment(first, byName) {
  let m;
  if ((m = first.match(ATTACH_IOS)) || (m = first.match(ATTACH_ANDROID))) return { name: m[1].trim() };
  if (OMITTED.test(first)) return { omitted: true };
  if (byName.has(nfc(first.trim()).toLowerCase())) return { name: first.trim() };
  return {};
}

/** Decide a ordem dia/mês pelos próprios dados (padrão: dia/mês, como no Brasil). */
function resolveOrder(tuples) {
  if (tuples.some(([a]) => a.length === 4)) return "YMD";
  if (tuples.some(([a]) => +a > 12)) return "DMY";
  if (tuples.some(([, b]) => +b > 12)) return "MDY";
  return "DMY";
}

function toDate([a, b, c], order) {
  let y, m, d;
  if (order === "YMD") [y, m, d] = [a, b, c];
  else if (order === "MDY") [m, d, y] = [a, b, c];
  else [d, m, y] = [a, b, c];
  y = +y; if (y < 100) y += 2000;
  return { y, m: +m, d: +d };
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * Lê o texto da conversa. `files` = caminhos dos arquivos que vieram no zip (para ligar cada anexo ao arquivo pelo nome).
 * Devolve { messages, senders, counts, firstDate, lastDate }.
 */
export function parseChat(raw, files = []) {
  const byName = new Map();
  for (const f of files) byName.set(baseName(f).toLowerCase(), f);

  // Passo 1: separa as mensagens. Linha sem cabeçalho de data pertence à mensagem anterior.
  const recs = [];
  for (const line of String(raw).replace(/^﻿/, "").split(/\r?\n/)) {
    const l = clean(line);
    const m = l.match(IOS) || l.match(ANDROID);
    if (m) recs.push({ date: [m[1], m[2], m[3]], h: +m[4], min: +m[5], sec: m[6] ? +m[6] : 0, ap: m[7] || "", first: m[8] || "", more: [] });
    else if (recs.length) recs[recs.length - 1].more.push(l);
  }
  const order = resolveOrder(recs.map((r) => r.date));

  // Passo 2: remetente, tipo e anexo de cada mensagem.
  const messages = recs.map((r, i) => {
    const { y, m, d } = toDate(r.date, order);
    let h = r.h;
    if (r.ap) h = (h % 12) + (/p/i.test(r.ap) ? 12 : 0);
    const date = `${y}-${pad(m)}-${pad(d)}`, time = `${pad(h)}:${pad(r.min)}`;
    const ts = Date.UTC(y, m - 1, d, h, r.min, r.sec);

    let sender = "", body = r.first;
    const sm = r.first.match(/^([^:]{1,60}?):(?:\s+([\s\S]*))?$/);
    if (sm && !/["“”]/.test(sm[1])) { sender = sm[1].trim(); body = sm[2] || ""; }
    const msg = { id: i, date, time, ts, sender: sender || SYSTEM_SENDER, kind: "texto", text: "", caption: "", fileName: "", file: null, missing: false, result: null, status: "done", error: "" };
    const tail = r.more.join("\n").replace(/\s+$/, "");

    if (!sender) { msg.kind = "sistema"; msg.text = [body, tail].filter(Boolean).join("\n"); return msg; }

    const att = detectAttachment(body.trim(), byName);
    if (att.name) {
      msg.fileName = att.name;
      msg.kind = kindFromName(att.name);
      msg.file = byName.get(nfc(baseName(att.name)).toLowerCase()) || null;
      msg.missing = !msg.file;
      msg.caption = tail.trim();
    } else if (att.omitted) {
      msg.kind = "outro"; msg.text = "mídia omitida na exportação (o arquivo não veio no zip)";
      msg.caption = tail.trim();
    } else {
      msg.text = [body, tail].filter(Boolean).join("\n");
    }
    // Só áudio, vídeo e imagem com arquivo no zip passam pela IA.
    if (msg.file && ["audio", "video", "imagem"].includes(msg.kind)) msg.status = "pending";
    return msg;
  });

  // Ordem cronológica (estável: mensagens do mesmo minuto ficam na ordem do arquivo).
  messages.sort((a, b) => a.ts - b.ts || a.id - b.id);

  return { messages, ...summarize(messages) };
}

function summarize(messages) {
  const counts = { texto: 0, audio: 0, video: 0, imagem: 0, documento: 0, figurinha: 0, contato: 0, outro: 0, sistema: 0 };
  const bySender = new Map();
  for (const m of messages) {
    counts[m.kind]++;
    if (m.kind !== "sistema") bySender.set(m.sender, (bySender.get(m.sender) || 0) + 1);
  }
  const senders = [...bySender.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  return { senders, counts, firstDate: messages[0]?.date || "", lastDate: messages[messages.length - 1]?.date || "" };
}

/** O que ainda precisa passar pela IA. */
export const pendingMedia = (messages) => messages.filter((m) => m.status === "pending" || m.status === "error");

// ===== Montagem das linhas =====

export const brDate = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
const oneLine = (s) => String(s || "").replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();

export function lineContent(m) {
  const cap = m.caption ? ` Legenda: "${oneLine(m.caption)}"` : "";
  switch (m.kind) {
    case "texto": case "sistema": return oneLine(m.text);
    case "audio": case "video": case "imagem": {
      const noFile = m.missing ? `arquivo ${m.fileName} não veio no zip` : null;
      if (noFile) return noFile + cap;
      if (m.status === "error") return `[não foi possível processar: ${oneLine(m.error) || "erro"}]${cap}`;
      if (m.status === "pending") return `[ainda não processado]${cap}`;
      if (m.status === "skipped") return `[não processado: ${oneLine(m.error) || "ignorado"}]${cap}`;
      const r = oneLine(m.result);
      if (m.kind === "imagem") return (r || "imagem sem descrição") + cap;
      return r || (m.kind === "video" ? "vídeo sem fala" : "áudio sem fala reconhecível");
    }
    default: return (m.fileName ? m.fileName : oneLine(m.text)) + cap;
  }
}

/** [15/10/2026 14:32] João (áudio): texto transcrito... */
export function formatLine(m) {
  return `[${brDate(m.date)} ${m.time}] ${m.sender} (${TYPE_LABEL[m.kind] || m.kind}): ${lineContent(m)}`;
}

export const toTranscript = (messages) => messages.map(formatLine).join("\n");

// ===== Filtros =====

export const normalize = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export const hasFilters = (f) => !!(f && (f.sender || f.from || f.to || (f.q && f.q.trim())));

export function applyFilters(messages, f) {
  if (!hasFilters(f)) return messages;
  const terms = normalize(f.q).split(/\s+/).filter(Boolean);
  return messages.filter((m) => {
    if (f.sender && m.sender !== f.sender) return false;
    if (f.from && m.date < f.from) return false;
    if (f.to && m.date > f.to) return false;
    if (terms.length) {
      const line = normalize(formatLine(m));
      if (!terms.every((t) => line.includes(t))) return false;
    }
    return true;
  });
}

export function describeFilters(f) {
  const parts = [];
  if (f.sender) parts.push(`pessoa: ${f.sender}`);
  if (f.from || f.to) parts.push(`período: ${f.from ? brDate(f.from) : "início"} a ${f.to ? brDate(f.to) : "fim"}`);
  if (f.q && f.q.trim()) parts.push(`busca: "${f.q.trim()}"`);
  return parts.join("; ");
}

// ===== Exportação em .md =====

export function toMarkdown(shown, { fileName = "", total = shown.length, filters = {}, senders = [], generated = new Date() } = {}) {
  const first = shown[0]?.date, last = shown[shown.length - 1]?.date;
  const gen = `${pad(generated.getDate())}/${pad(generated.getMonth() + 1)}/${generated.getFullYear()}`;
  const head = [
    "# Conversa do WhatsApp",
    "",
    fileName ? `- Arquivo: ${fileName}` : null,
    first ? `- Período: ${brDate(first)} a ${brDate(last)}` : null,
    senders.length ? `- Participantes: ${senders.join(", ")}` : null,
    `- Mensagens: ${shown.length}${shown.length !== total ? ` (de ${total} na conversa completa)` : ""}`,
    hasFilters(filters) ? `- Filtros aplicados: ${describeFilters(filters)}` : null,
    `- Gerado pelo Transcriby em ${gen}`,
    "",
    "---",
    "",
  ].filter((x) => x !== null).join("\n");
  // Duas barras no fim da linha viram quebra de linha no Markdown, sem poluir o texto.
  return head + shown.map((m) => formatLine(m) + "  ").join("\n") + "\n";
}

// ===== Duração =====

/** 3 h 12 min / 45 min / 30 s */
export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h) return `${h} h ${pad(m)} min`;
  if (m) return `${m} min`;
  return `${sec} s`;
}
