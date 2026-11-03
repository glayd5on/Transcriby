// ===== Alerta de tentativas de descoberta (Cloudflare Worker + Telegram) =====
// Roda antes de cada pergunta ao Reo. Conta tentativas suspeitas por IP e por sessão (Cloudflare KV, janela de 10 min),
// avisa no Telegram e bloqueia o IP. Também limita o total de mensagens por IP, o que protege o custo do Gemini.
//
// Precisa de (tudo opcional: sem isso o Worker continua funcionando, só sem o alerta e com limite mais fraco):
//   KV:        binding ABUSE_KV (ver wrangler.toml)
//   Segredos:  TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID

export const CFG = {
  threshold: 5,        // tentativas suspeitas na janela para disparar o alerta
  windowSec: 600,      // janela de contagem (10 min)
  maxMsgs: 40,         // limite geral de mensagens por IP na janela
  blockOnAlert: true,  // bloquear o IP ao disparar o alerta
  blockSec: 3600,      // duração do bloqueio (1 h)
};

export const SUSPICIOUS = [
  /(prompt|instru[cç][aã]o|instru[cç][õo]es|regras)\s+(do\s+)?(sistema|interna|inicial|oculta)/i,
  /seu\s+(prompt|modelo|llm)\b/i,
  /que\s+modelo\s+(voc[eê]|vc)/i,
  /(voc[eê]|vc)\s+(é|e|usa|roda|foi\s+feito)\s+.{0,20}(gpt|chatgpt|gemini|claude|openai|google|anthropic|llama|deepseek)/i,
  /ignore\s+(todas\s+)?(as\s+)?(instru|regras|ordens|anteriores)/i,
  /(repita|mostre|revele|exiba|imprima|vaze)\s+.{0,40}(instru|prompt|regras|acima|configura)/i,
  /(system\s*prompt|your\s+instructions|ignore\s+(all\s+)?(previous|prior)|reveal\s+your|what\s+model\s+are\s+you|jailbreak|developer\s+mode)/i,
  /(qual|quem)\s+(é\s+)?(a\s+)?(empresa|tecnologia|api|provedor)\s+por\s+tr[aá]s/i,
  /modo\s+desenvolvedor/i,
];

export const isSuspicious = (t) => SUSPICIOUS.some((r) => r.test(t || ""));

// Sem o KV configurado, usa a memória do próprio Worker (some quando ele reinicia e não é compartilhada
// entre servidores): é um freio fraco, mas melhor que nenhum.
const mem = new Map();
const memStore = {
  async get(key) {
    const e = mem.get(key);
    if (!e) return null;
    if (e.exp <= Date.now()) { mem.delete(key); return null; }
    return e.value;
  },
  async put(key, value, opts) {
    if (mem.size > 5000) mem.clear();
    mem.set(key, { value, exp: Date.now() + ((opts && opts.expirationTtl) || 60) * 1000 });
  },
};
const kv = (env) => env.ABUSE_KV || memStore;

async function bump(env, key, ttl) {
  const store = kv(env);
  const n = parseInt((await store.get(key)) || "0", 10) + 1;
  await store.put(key, String(n), { expirationTtl: Math.max(ttl, 60) });
  return n;
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;   // sem Telegram configurado: não avisa
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 3800) }),
    });
  } catch (_) { /* o alerta nunca pode derrubar o chat */ }
}

const tooMany = (cors) =>
  new Response(JSON.stringify({ error: "Muitas tentativas. Tente novamente mais tarde." }), {
    status: 429,
    headers: { ...(cors || {}), "content-type": "application/json" },
  });

// Retorna uma Response 429 se deve barrar; null se pode seguir para o Gemini.
export async function guardChat(request, env, ctx, userMessage, cors) {
  const store = kv(env);
  const ip = request.headers.get("CF-Connecting-IP") || "desconhecido";
  const session = (request.headers.get("X-Session-Id") || "").slice(0, 64);
  const country = request.cf?.country || "?";

  if (await store.get(`block:${ip}`)) return tooMany(cors);
  if ((await bump(env, `rate:${ip}`, CFG.windowSec)) > CFG.maxMsgs) return tooMany(cors);

  if (!isSuspicious(userMessage)) return null;

  // guarda as últimas mensagens suspeitas para mandar no alerta
  const logKey = `log:${ip}`;
  const log = JSON.parse((await store.get(logKey)) || "[]");
  log.push(String(userMessage).slice(0, 200));
  await store.put(logKey, JSON.stringify(log.slice(-5)), { expirationTtl: CFG.windowSec });

  const counts = [await bump(env, `sus:ip:${ip}`, CFG.windowSec)];
  if (session) counts.push(await bump(env, `sus:ses:${session}`, CFG.windowSec));
  const tentativas = Math.max(...counts);

  if (tentativas >= CFG.threshold) {
    if (!(await store.get(`alerted:${ip}`))) {
      await store.put(`alerted:${ip}`, "1", { expirationTtl: 1800 });
      const text =
        `🚨 Reo: tentativas de descobrir como o chat funciona\n` +
        `IP: ${ip} (${country})\nSessão: ${session || "sem ID"}\n` +
        `Tentativas: ${tentativas} em ${CFG.windowSec / 60} min\n` +
        `Últimas mensagens:\n- ${log.join("\n- ")}`;
      ctx.waitUntil(sendTelegram(env, text));
    }
    if (CFG.blockOnAlert) {
      await store.put(`block:${ip}`, "1", { expirationTtl: CFG.blockSec });
      return tooMany(cors);
    }
  }
  return null;
}
