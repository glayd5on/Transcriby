// Importador de conversas do WhatsApp (no navegador): abre o .zip aos poucos, mede a duração do áudio,
// e transcreve áudios, a fala dos vídeos e descreve imagens. O vídeo NUNCA é enviado: só a faixa de áudio dele.
import { decodeToMono16k, probeMedia, NoAudio } from "./audio.js";
import { transcribeWithGemini, transcribeRaw, describeImage, NeedKey, LimitError } from "./gemini.js";
import { baseName, extOf } from "./whatsapp.js";

// zip.js lê o .zip aos poucos (sem carregar tudo na memória). Tenta mais de um endereço, por garantia.
const ZIP_SOURCES = [
  "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.23.0/index.js",
  "https://unpkg.com/@zip.js/zip.js@2.23.0/index.js",
  "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.23.0/+esm",
];
let zipLib = null;
async function loadZip() {
  if (zipLib) return zipLib;
  let last;
  for (const src of ZIP_SOURCES) {
    try { zipLib = await import(src); zipLib.configure({ useWebWorkers: false }); return zipLib; }
    catch (e) { last = e; }
  }
  throw new Error("não consegui carregar o leitor de .zip (" + ((last && last.message) || last) + ")");
}

const IMAGE_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif" };
const AUDIO_MIME = { opus: "audio/ogg", ogg: "audio/ogg", oga: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", flac: "audio/flac" };
const RAW_MAX = 12 * 1024 * 1024;       // áudio enviado sem converter precisa caber numa requisição
const MAX_IMAGE_SIDE = 1280;            // imagens maiores são reduzidas antes do envio (mais rápido e mais barato)
const LIGHT_CONCURRENCY = 3;            // áudios e imagens em paralelo; vídeos um de cada vez (usam bastante memória)

const isChatName = (n) => /^(_chat|conversa do whatsapp.*|whatsapp chat.*|chat do whatsapp.*)\.txt$/i.test(n);

/** Abre o .zip e acha o arquivo de texto da conversa. */
export async function openChatZip(file) {
  const zip = await loadZip();
  const reader = new zip.ZipReader(new zip.BlobReader(file));
  const all = await reader.getEntries();
  const entries = all.filter((e) => !e.directory && !/(^|\/)__MACOSX\//.test(e.filename) && !baseName(e.filename).startsWith("._"));
  const txts = entries.filter((e) => extOf(e.filename) === "txt");
  const chat = txts.find((e) => baseName(e.filename).toLowerCase() === "_chat.txt")
    || txts.find((e) => isChatName(baseName(e.filename)))
    || [...txts].sort((a, b) => b.uncompressedSize - a.uncompressedSize)[0];
  if (!chat) { await reader.close(); throw new Error("não encontrei o arquivo de texto da conversa (_chat.txt) dentro do .zip"); }
  const text = await chat.getData(new zip.TextWriter("utf-8"));
  const byPath = new Map(entries.map((e) => [e.filename, e]));
  return {
    chatName: chat.filename,
    text,
    paths: entries.filter((e) => e !== chat).map((e) => e.filename),
    /** Tira um arquivo do zip como Blob (só este arquivo fica na memória). */
    async getBlob(path, type = "") {
      const e = byPath.get(path);
      if (!e) throw new Error("arquivo não está no zip");
      return e.getData(new zip.BlobWriter(type));
    },
    close: () => reader.close(),
  };
}

/**
 * Mede o áudio de cada áudio/vídeo do zip (só lê o cabeçalho, não decodifica nem envia nada).
 * Preenche m.duration (segundos) e devolve { totalSec, estimated, noSpeechVideos }.
 */
export async function measureAudio(zipFile, messages, onProgress = () => {}) {
  const list = messages.filter((m) => m.file && (m.kind === "audio" || m.kind === "video"));
  let totalSec = 0, estimated = false, noSpeechVideos = 0;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    onProgress(i, list.length);
    const blob = await zipFile.getBlob(m.file);
    const p = await probeMedia(blob);
    if (p.hasAudio === false) { m.duration = 0; m.status = "done"; m.result = ""; noSpeechVideos++; }   // sem faixa de áudio: não há o que transcrever
    else if (p.duration !== null) m.duration = p.duration;
    else { m.duration = blob.size / (m.kind === "audio" ? 16000 : 250000); estimated = true; }   // não deu para ler: estimativa pelo tamanho
    totalSec += m.duration;
  }
  onProgress(list.length, list.length);
  return { totalSec, estimated, noSpeechVideos };
}

/** Reduz imagens grandes (e converte formatos que o modelo não lê) para JPEG. */
async function prepareImage(blob, name) {
  const ext = extOf(name), mime = IMAGE_MIME[ext];
  try {
    const bmp = await createImageBitmap(blob);
    const side = Math.max(bmp.width, bmp.height);
    if (mime && mime !== "image/heic" && mime !== "image/heif" && side <= MAX_IMAGE_SIDE && blob.size <= 1.5 * 1024 * 1024) { bmp.close && bmp.close(); return { blob, mime }; }
    const k = Math.min(1, MAX_IMAGE_SIDE / side);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);   // fundo branco para PNG/WebP transparente
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    const jpg = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
    if (jpg) return { blob: jpg, mime: "image/jpeg" };
  } catch (_) { /* cai no envio do arquivo original */ }
  if (mime) return { blob, mime };
  throw new Error("formato de imagem não suportado");
}

async function transcribeAudioBlob(blob, name, kind, o) {
  let audio;
  try {
    audio = await decodeToMono16k(new File([blob], name, { type: blob.type }));
  } catch (e) {
    if (e instanceof NoAudio) return "";                   // vídeo sem faixa de áudio: sem fala
    const mime = AUDIO_MIME[extOf(name)];
    if (kind === "audio" && mime && blob.size <= RAW_MAX)  // áudio que o navegador não decodifica: envia o arquivo como está
      return transcribeRaw(blob, mime, o);
    throw e;
  }
  if (audio.length < 16000 * 0.3) return "";               // menos de 0,3 s: nada a transcrever
  const segs = await transcribeWithGemini(audio, o);
  return segs.map((s) => s.text).join(" ").trim();
}

/**
 * Processa o que falta (áudios, fala dos vídeos, imagens). Cada item termina com status "done" ou "error".
 * Se o servidor pedir o código de acesso, o erro NeedKey sobe e o que já foi feito é mantido.
 */
export async function processMedia(zipFile, messages, { url, language, key, onProgress = () => {}, control = { stop: false } }) {
  const todo = messages.filter((m) => m.file && (m.status === "pending" || m.status === "error"));
  const total = todo.length;
  let done = 0, fatal = null;
  const o = { url, language, key };

  const run = async (m) => {
    try {
      onProgress(done, total, m);
      const blob = await zipFile.getBlob(m.file);
      if (m.kind === "imagem") {
        const img = await prepareImage(blob, m.fileName || m.file);
        m.result = await describeImage(img.blob, img.mime, o);
      } else {
        m.result = await transcribeAudioBlob(blob, baseName(m.file), m.kind, o);
      }
      m.status = "done"; m.error = "";
    } catch (e) {
      if (e instanceof NeedKey || e instanceof LimitError) { fatal = e; return; }   // para tudo; o que falta continua "pendente"
      m.status = "error"; m.error = (e && e.message) || String(e);
    }
    done++; onProgress(done, total, m);
  };

  const queue = (items, concurrency) => {
    let next = 0;
    const worker = async () => {
      while (!fatal && !control.stop) {
        const m = items[next++];
        if (!m) return;
        await run(m);
      }
    };
    return Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  };

  await Promise.all([
    queue(todo.filter((m) => m.kind !== "video"), LIGHT_CONCURRENCY),
    queue(todo.filter((m) => m.kind === "video"), 1),
  ]);
  if (fatal) throw fatal;
  return { total, done, stopped: !!control.stop };
}
