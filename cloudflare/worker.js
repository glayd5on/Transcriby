// Mini servidor grátis (Cloudflare Worker): guarda a chave do Google e repassa o áudio, as imagens e o chat ao Gemini.
// Dois jeitos de autenticar (use um):
//   VERTEX:    GOOGLE_SERVICE_ACCOUNT (secreta, o conteúdo do arquivo .json da conta de serviço)
//              + VERTEX_LOCATION (opcional, padrão us-central1)
//   AI STUDIO: GEMINI_API_KEY (secreta)
// Comuns: ACCESS_KEY (senha do site, opcional), ALLOWED_ORIGIN (outros endereços permitidos, separados por vírgula; os SITE_ORIGINS abaixo já valem sempre).
// Modelos (opcionais; trocam os padrões abaixo): MODEL_LITE, MODEL_FLASH, MODEL_FALLBACK.
// Alerta do chat (opcionais): KV ABUSE_KV (wrangler.toml) e segredos TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Ver guard.js.
//
// Usos (POST):
//   áudio (corpo binário, WAV por padrão)  -> { segments: [{ start: "MM:SS", text, paragraph }], text }
//   ?mode=image (corpo = imagem)           -> { text } (descrição curta)
//   ?mode=summary (corpo JSON {text})      -> { summary }
//   ?mode=chat (corpo JSON {message, history, transcript}) -> { reply }   (Reo)

import { buildReoSystem } from "./reo.js";
import { guardChat, guardStatus } from "./guard.js";

// ===== Modelos (constantes configuráveis) =====
const MODEL_LITE = "gemini-3.1-flash-lite";   // transcrição de áudio e descrição de imagem
const MODEL_FLASH = "gemini-3.8-flash";       // chat do Reo, resumos e organização (só quando a pessoa pede no site)
const MODEL_FALLBACK = "gemini-2.5-flash";    // usado só se o modelo acima não existir naquela região/projeto

const MAX_BYTES = 14 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 3_000_000;   // transcrição enviada ao chat (~1 milhão de tokens)
const MAX_MESSAGE_CHARS = 4000;           // pergunta do usuário ao Reo
const MAX_HISTORY_TURNS = 16;             // mensagens anteriores lembradas pelo Reo
const AUDIO_MIMES = ["audio/wav", "audio/x-wav", "audio/ogg", "audio/opus", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/m4a", "audio/aac", "audio/x-aac", "audio/flac", "audio/webm"];
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const MAX_TEXT_CHARS = 2_000_000;   // ~ 8 horas de fala; cabe folgado na janela do Gemini
const PROMPT = (lang) => `Transcreva este áudio ${lang ? `em ${lang}` : ""} palavra por palavra, do começo ao fim, sem resumir e sem cortar nada.
Devolva uma lista JSON de trechos, na ordem em que são falados. Cada trecho tem:
- "start": o instante em que o trecho começa, no formato MM:SS, contado a partir do início deste áudio (ex.: "00:00", "01:27").
- "text": o que foi dito, em uma ou poucas frases (um trecho dura no máximo uns 20 segundos).
- "paragraph": true quando o trecho abre um novo parágrafo (mudança de assunto ou pausa longa), senão false. O primeiro trecho é sempre true.
Regras:
- Escreva com ortografia, acentuação e pontuação corretas.
- Não identifique quem fala, a menos que seja necessário para entender.
- Não traduza, não explique e não comente.
- Ignore músicas e ruídos. Se não houver fala, devolva uma lista vazia.`;
const SEGMENTS_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: { start: { type: "STRING" }, text: { type: "STRING" }, paragraph: { type: "BOOLEAN" } },
    required: ["start", "text", "paragraph"],
  },
};
const IMAGE_PROMPT = `Descreva esta imagem, enviada numa conversa de WhatsApp, em uma ou duas frases curtas e objetivas, em português do Brasil.
Regras:
- Diga só o que é visível: pessoas, objetos, lugar, ação. Não invente nomes, não adivinhe intenções.
- Se houver texto legível importante (documento, placa, mensagem na tela), transcreva o essencial entre aspas.
- Comece direto pelo conteúdo (ex.: "Contrato assinado sobre uma mesa."). Sem introdução e sem comentários.`;
const SUMMARY_SIZES = {
  curto: "um resumo curto: um parágrafo de abertura e de 5 a 8 tópicos com os pontos principais",
  completo: "um resumo completo e bem organizado: uma visão geral, depois os assuntos na ordem em que aparecem (cada um com um título curto e um parágrafo), e no fim os pontos principais em tópicos",
};
const SUMMARY_PROMPT = (lang, size) => `Leia a transcrição abaixo (de um áudio, vídeo ou audiolivro) e escreva ${SUMMARY_SIZES[size] || SUMMARY_SIZES.completo}.
Regras:
- Escreva ${lang ? `em ${lang}` : "no mesmo idioma da transcrição"}, com ortografia e acentuação corretas.
- Use só o que está na transcrição. Não invente nomes, datas nem fatos.
- Não comente a transcrição; devolva só o resumo.

TRANSCRIÇÃO:
`;
const LANGS = { portuguese: "português do Brasil", english: "inglês", spanish: "espanhol" };

// Endereços públicos do site (não são segredo). Valem sempre, além do que estiver em ALLOWED_ORIGIN.
const SITE_ORIGINS = ["https://glayd5on.github.io", "https://transcriby.glaydson.work"];

const cors = (env, req) => {
  const o = req.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN ? [...new Set([...SITE_ORIGINS, ...env.ALLOWED_ORIGIN.split(",").map(s => s.trim()).filter(Boolean)])] : null;
  return {
    "Access-Control-Allow-Origin": !allowed || allowed.includes(o) ? (o || "*") : allowed[0],
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Key, X-Session-Id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
};
const json = (data, status, h) => new Response(JSON.stringify(data), { status, headers: { ...h, "Content-Type": "application/json" } });

function toBase64(bytes) {
  let s = ""; const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(s);
}

const b64url = (data) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let tokenCache = { token: "", exp: 0 };

// Troca o arquivo da conta de serviço por um token de acesso do Google (válido por 1 hora).
async function vertexToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - 60 > now) return tokenCache.token;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const pem = sa.private_key.replace(/-----[A-Z ]+-----|\s/g, "");
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claim}`));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${b64url(sig)}` }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.error_description || "não consegui entrar na conta de serviço do Google");
  tokenCache = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return tokenCache.token;
}

function endpoint(env, model, sa) {
  if (!sa) return { url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, headers: { "x-goog-api-key": env.GEMINI_API_KEY } };
  const loc = env.VERTEX_LOCATION || "us-central1";
  const host = loc === "global" ? "aiplatform.googleapis.com" : `${loc}-aiplatform.googleapis.com`;
  return { url: `https://${host}/v1/projects/${sa.project_id}/locations/${loc}/publishers/google/models/${model}:generateContent` };
}

// Modelos da família 2.x aceitam temperatura 0; nos 3.x o Google recomenda deixar o padrão.
const configFor = (model, cfg) => {
  const { temperature, ...rest } = cfg || {};
  return /^gemini-2/.test(model) && temperature !== undefined ? { ...rest, temperature } : rest;
};
const isModelMissing = (status, msg) => status === 404 || /not found|does not exist|not supported|unsupported/i.test(msg || "");

async function callGemini(env, sa, parts, generationConfig, { model, systemInstruction, contents } = {}) {
  const main = model || env.MODEL_FLASH || MODEL_FLASH;
  const fallback = env.MODEL_FALLBACK || MODEL_FALLBACK;
  const headers0 = { "Content-Type": "application/json" };
  if (sa) {
    try { headers0.Authorization = `Bearer ${await vertexToken(sa)}`; }
    catch (e) { return { error: String(e.message || e), status: 502 }; }
  }
  let last;
  for (const m of main === fallback ? [main] : [main, fallback]) {
    const ep = endpoint(env, m, sa);
    const body = {
      contents: contents || [{ role: "user", parts }],
      generationConfig: configFor(m, generationConfig),
    };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    const r = await fetch(ep.url, { method: "POST", headers: { ...headers0, ...(ep.headers || {}) }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { text: (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("").trim(), model: m };
    const msg = data.error?.message || `Gemini respondeu ${r.status}`;
    last = { error: msg, status: r.status === 429 ? 429 : 502 };
    if (!isModelMissing(r.status, msg)) return last;   // só tenta o modelo reserva quando o modelo principal não existe
  }
  return last;
}

// Garante o formato [{ start, text, paragraph }] mesmo se o modelo errar um campo.
function cleanSegments(raw) {
  let list;
  try { list = JSON.parse(raw || "[]"); } catch (_) { return null; }
  if (!Array.isArray(list)) return null;
  return list
    .filter(s => s && typeof s.text === "string" && s.text.trim())
    .map(s => ({ start: String(s.start ?? ""), text: s.text.trim(), paragraph: s.paragraph === true }));
}

const textOf = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

// Mime do corpo: só aceita os tipos que o Gemini entende; senão assume o padrão.
function mimeFrom(req, allowed, fallback) {
  const m = (req.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  return allowed.includes(m) ? m : fallback;
}

export default {
  async fetch(req, env, ctx) {
    const h = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    // Diagnóstico (abrir o endereço do Worker no navegador): só mostra se as peças estão ligadas, nunca valores.
    if (req.method === "GET" && new URL(req.url).searchParams.has("status")) return json(await guardStatus(env), 200, h);
    if (req.method !== "POST") return json({ error: "use POST" }, 405, h);
    if (env.ACCESS_KEY && req.headers.get("X-Access-Key") !== env.ACCESS_KEY) return json({ error: "código de acesso incorreto" }, 401, h);
    let sa = null;
    if (env.GOOGLE_SERVICE_ACCOUNT) {
      try { sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT); } catch (_) { return json({ error: "GOOGLE_SERVICE_ACCOUNT não é um JSON válido" }, 500, h); }
    } else if (!env.GEMINI_API_KEY) return json({ error: "servidor sem chave do Google" }, 500, h);

    const q = new URL(req.url).searchParams;
    const mode = q.get("mode") || "audio";
    const lite = env.MODEL_LITE || MODEL_LITE;
    const flash = env.MODEL_FLASH || MODEL_FLASH;

    // ===== Chat com o Reo: só texto, só modelo de texto, único contexto = a transcrição enviada =====
    if (mode === "chat") {
      let body;
      try { body = await req.json(); } catch (_) { return json({ error: "corpo inválido" }, 400, h); }
      const message = textOf(body?.message, MAX_MESSAGE_CHARS).trim();
      const transcript = typeof body?.transcript === "string" ? body.transcript : "";
      if (!message) return json({ error: "mensagem vazia" }, 400, h);
      if (!transcript.trim()) return json({ error: "sem conversa para analisar" }, 400, h);
      if (transcript.length > MAX_TRANSCRIPT_CHARS) return json({ error: "a conversa é grande demais para o chat" }, 413, h);

      const barrado = await guardChat(req, env, ctx || { waitUntil() {} }, message, h);
      if (barrado) return barrado;

      // Histórico: só texto, papéis válidos, as últimas mensagens; precisa terminar numa pergunta do usuário.
      const history = (Array.isArray(body.history) ? body.history : [])
        .filter(t => t && (t.role === "user" || t.role === "model") && typeof t.text === "string" && t.text.trim())
        .slice(-MAX_HISTORY_TURNS)
        .map(t => ({ role: t.role, parts: [{ text: t.text.slice(0, 8000) }] }));
      while (history.length && history[0].role !== "user") history.shift();
      const contents = [...history, { role: "user", parts: [{ text: message }] }];

      const out = await callGemini(env, sa, null, { maxOutputTokens: 8192 }, { model: flash, systemInstruction: buildReoSystem(transcript), contents });
      if (out.error) return json({ error: out.error }, out.status, h);
      return json({ reply: out.text || "Não consegui responder agora. Tente reformular a pergunta." }, 200, h);
    }

    if (mode === "summary") {
      let body;
      try { body = await req.json(); } catch (_) { return json({ error: "corpo inválido" }, 400, h); }
      const text = String(body?.text || "").trim();
      if (!text) return json({ error: "texto vazio" }, 400, h);
      if (text.length > MAX_TEXT_CHARS) return json({ error: "texto grande demais para resumir" }, 413, h);
      const out = await callGemini(env, sa, [{ text: SUMMARY_PROMPT(LANGS[body.lang] || "", body.size) + text }], { temperature: 0.3, maxOutputTokens: 16384 }, { model: flash });
      if (out.error) return json({ error: out.error }, out.status, h);
      return json({ summary: out.text }, 200, h);
    }

    const bytes = new Uint8Array(await req.arrayBuffer());

    // ===== Descrição curta de uma imagem =====
    if (mode === "image") {
      if (!bytes.length) return json({ error: "imagem vazia" }, 400, h);
      if (bytes.length > MAX_BYTES) return json({ error: "imagem grande demais" }, 413, h);
      const out = await callGemini(env, sa,
        [{ text: IMAGE_PROMPT }, { inlineData: { mimeType: mimeFrom(req, IMAGE_MIMES, "image/jpeg"), data: toBase64(bytes) } }],
        { temperature: 0, maxOutputTokens: 1024 }, { model: lite });
      if (out.error) return json({ error: out.error }, out.status, h);
      return json({ text: out.text }, 200, h);
    }

    // ===== Transcrição de áudio (padrão) =====
    if (!bytes.length) return json({ error: "áudio vazio" }, 400, h);
    if (bytes.length > MAX_BYTES) return json({ error: "parte de áudio grande demais" }, 413, h);

    const lang = LANGS[q.get("lang")] || "";
    const out = await callGemini(env, sa,
      [{ text: PROMPT(lang) }, { inlineData: { mimeType: mimeFrom(req, AUDIO_MIMES, "audio/wav"), data: toBase64(bytes) } }],
      { temperature: 0, maxOutputTokens: 32768, responseMimeType: "application/json", responseSchema: SEGMENTS_SCHEMA }, { model: lite });
    if (out.error) return json({ error: out.error }, out.status, h);
    const segments = cleanSegments(out.text);
    if (!segments) return json({ error: "o modelo devolveu uma resposta fora do formato" }, 502, h);
    return json({ segments, text: segments.map(s => s.text).join(" ") }, 200, h);
  },
};
