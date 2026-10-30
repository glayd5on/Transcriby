// Mini servidor grátis (Cloudflare Worker): guarda a chave do Google e repassa o áudio ao Gemini.
// Dois jeitos de autenticar (use um):
//   VERTEX:    GOOGLE_SERVICE_ACCOUNT (secreta, o conteúdo do arquivo .json da conta de serviço)
//              + VERTEX_LOCATION (opcional, padrão us-central1)
//   AI STUDIO: GEMINI_API_KEY (secreta)
// Comuns: ACCESS_KEY (senha do site, opcional), ALLOWED_ORIGIN (ex.: https://glayd5on.github.io), GEMINI_MODEL (opcional).
//
// Dois usos (POST):
//   áudio WAV (corpo binário)          -> { segments: [{ start: "MM:SS", text, paragraph }], text }
//   ?mode=summary (corpo JSON {text})  -> { summary }

const MAX_BYTES = 14 * 1024 * 1024;
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

const cors = (env, req) => {
  const o = req.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN ? env.ALLOWED_ORIGIN.split(",").map(s => s.trim()) : null;
  return {
    "Access-Control-Allow-Origin": !allowed || allowed.includes(o) ? (o || "*") : allowed[0],
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Key",
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

async function callGemini(env, sa, parts, generationConfig) {
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const ep = endpoint(env, model, sa);
  const headers = { "Content-Type": "application/json", ...(ep.headers || {}) };
  if (sa) {
    try { headers.Authorization = `Bearer ${await vertexToken(sa)}`; }
    catch (e) { return { error: String(e.message || e), status: 502 }; }
  }
  const r = await fetch(ep.url, {
    method: "POST", headers,
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { error: data.error?.message || `Gemini respondeu ${r.status}`, status: r.status === 429 ? 429 : 502 };
  return { text: (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim() };
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

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (req.method !== "POST") return json({ error: "use POST" }, 405, h);
    if (env.ACCESS_KEY && req.headers.get("X-Access-Key") !== env.ACCESS_KEY) return json({ error: "código de acesso incorreto" }, 401, h);
    let sa = null;
    if (env.GOOGLE_SERVICE_ACCOUNT) {
      try { sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT); } catch (_) { return json({ error: "GOOGLE_SERVICE_ACCOUNT não é um JSON válido" }, 500, h); }
    } else if (!env.GEMINI_API_KEY) return json({ error: "servidor sem chave do Google" }, 500, h);

    const q = new URL(req.url).searchParams;

    if (q.get("mode") === "summary") {
      let body;
      try { body = await req.json(); } catch (_) { return json({ error: "corpo inválido" }, 400, h); }
      const text = String(body?.text || "").trim();
      if (!text) return json({ error: "texto vazio" }, 400, h);
      if (text.length > MAX_TEXT_CHARS) return json({ error: "texto grande demais para resumir" }, 413, h);
      const out = await callGemini(env, sa, [{ text: SUMMARY_PROMPT(LANGS[body.lang] || "", body.size) + text }], { temperature: 0.3, maxOutputTokens: 16384 });
      if (out.error) return json({ error: out.error }, out.status, h);
      return json({ summary: out.text }, 200, h);
    }

    const audio = new Uint8Array(await req.arrayBuffer());
    if (!audio.length) return json({ error: "áudio vazio" }, 400, h);
    if (audio.length > MAX_BYTES) return json({ error: "parte de áudio grande demais" }, 413, h);

    const lang = LANGS[q.get("lang")] || "";
    const out = await callGemini(env, sa,
      [{ text: PROMPT(lang) }, { inlineData: { mimeType: "audio/wav", data: toBase64(audio) } }],
      { temperature: 0, maxOutputTokens: 32768, responseMimeType: "application/json", responseSchema: SEGMENTS_SCHEMA });
    if (out.error) return json({ error: out.error }, out.status, h);
    const segments = cleanSegments(out.text);
    if (!segments) return json({ error: "o modelo devolveu uma resposta fora do formato" }, 502, h);
    return json({ segments, text: segments.map(s => s.text).join(" ") }, 200, h);
  },
};
