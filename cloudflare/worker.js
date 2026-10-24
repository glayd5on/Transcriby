// Mini servidor grátis (Cloudflare Worker): guarda a chave do Google e repassa o áudio ao Gemini.
// Variáveis (Settings > Variables): GEMINI_API_KEY (secreta), ACCESS_KEY (senha do site, opcional),
// ALLOWED_ORIGIN (ex.: https://glayd5on.github.io), GEMINI_MODEL (opcional).

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

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (req.method !== "POST") return json({ error: "use POST" }, 405, h);
    if (env.ACCESS_KEY && req.headers.get("X-Access-Key") !== env.ACCESS_KEY) return json({ error: "código de acesso incorreto" }, 401, h);
    if (!env.GEMINI_API_KEY) return json({ error: "servidor sem chave do Gemini" }, 500, h);

    const body = new Uint8Array(await req.arrayBuffer());
    if (!body.length) return json({ error: "áudio vazio" }, 400, h);
    if (body.length > MAX_BYTES) return json({ error: "parte de áudio grande demais" }, 413, h);

    const lang = LANGS[new URL(req.url).searchParams.get("lang")] || "";
    const model = env.GEMINI_MODEL || "gemini-2.5-flash";
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT(lang) }, { inline_data: { mime_type: "audio/wav", data: toBase64(body) } }] }],
        generationConfig: { temperature: 0 },
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: data.error?.message || `Gemini respondeu ${r.status}` }, r.status === 429 ? 429 : 502, h);
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
    return json({ text }, 200, h);
  },
};
