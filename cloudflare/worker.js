// Mini servidor grátis (Cloudflare Worker): guarda a chave do Google e repassa o áudio ao Gemini.
// Dois jeitos de autenticar (use um):
//   VERTEX:    GOOGLE_SERVICE_ACCOUNT (secreta, o conteúdo do arquivo .json da conta de serviço)
//              + VERTEX_LOCATION (opcional, padrão us-central1)
//   AI STUDIO: GEMINI_API_KEY (secreta)
// Comuns: ACCESS_KEY (senha do site, opcional), ALLOWED_ORIGIN (ex.: https://glayd5on.github.io), GEMINI_MODEL (opcional).

const MAX_BYTES = 14 * 1024 * 1024;
const PROMPT = (lang) => `Transcreva este áudio ${lang ? `em ${lang}` : ""} palavra por palavra, do começo ao fim, sem resumir e sem cortar nada.
Regras:
- Escreva com ortografia, acentuação e pontuação corretas, em parágrafos bem divididos por assunto.
- Não escreva horários nem marcações de tempo.
- Não identifique quem fala, a menos que seja necessário para entender.
- Não traduza, não explique e não comente. Devolva só o texto transcrito.
- Ignore músicas e ruídos. Se não houver fala, devolva um texto vazio.`;
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

    const body = new Uint8Array(await req.arrayBuffer());
    if (!body.length) return json({ error: "áudio vazio" }, 400, h);
    if (body.length > MAX_BYTES) return json({ error: "parte de áudio grande demais" }, 413, h);

    const lang = LANGS[new URL(req.url).searchParams.get("lang")] || "";
    const model = env.GEMINI_MODEL || "gemini-2.5-flash";
    const ep = endpoint(env, model, sa);
    const headers = { "Content-Type": "application/json", ...(ep.headers || {}) };
    if (sa) {
      try { headers.Authorization = `Bearer ${await vertexToken(sa)}`; }
      catch (e) { return json({ error: String(e.message || e) }, 502, h); }
    }
    const r = await fetch(ep.url, {
      method: "POST", headers,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: PROMPT(lang) }, { inlineData: { mimeType: "audio/wav", data: toBase64(body) } }] }],
        generationConfig: { temperature: 0 },
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: data.error?.message || `Gemini respondeu ${r.status}` }, r.status === 429 ? 429 : 502, h);
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
    return json({ text }, 200, h);
  },
};
