// ===== Limite diário de uso + código de liberação (Cloudflare Worker) =====
// Cada pessoa (IP) e o site inteiro têm um limite por dia, contado em "minutos de uso":
//   áudio = a duração dele; imagem, resumo e pergunta ao Reo valem alguns minutos (ver COST).
// Quem digita um código válido (segredo UNLIMITED_CODES, separados por vírgula) fica sem limite.
// O contador fica num Durable Object (binding USAGE), que soma sem erro mesmo com pedidos ao mesmo tempo.
// Sem o binding USAGE o Worker usa a memória dele (freio fraco: some quando reinicia) e o ?status avisa.
//
// Variáveis opcionais: DAILY_LIMIT_IP_MIN (padrão 60), DAILY_LIMIT_SITE_MIN (padrão 3000), UNLIMITED_CODES (segredo).

export const DEFAULTS = { ipMin: 60, siteMin: 3000 };
export const COST = { image: 0.2, summary: 2, chat: 2 };   // em minutos de uso
export const MAX_BAD_CODES = 10;                            // códigos errados por IP por hora antes de bloquear

const round = (n) => Math.round(n * 1000) / 1000;
const BRT = 3 * 3600 * 1000;   // Brasília = UTC-3 (sem horário de verão)

/** Dia (AAAA-MM-DD) no horário de Brasília. */
export const dayKey = (now = Date.now()) => new Date(now - BRT).toISOString().slice(0, 10);
/** Quando o contador zera: meia-noite de Brasília, em ISO UTC. */
export const resetAt = (now = Date.now()) => new Date(Date.parse(dayKey(now) + "T00:00:00Z") + 86400000 + BRT).toISOString();

/** IPv6 conta pelo bloco /64 (um mesmo aparelho muda os últimos números o tempo todo). */
export function ipKey(ip) {
  ip = String(ip || "desconhecido");
  if (!ip.includes(":")) return ip;
  const full = ip.includes("::") ? (() => { const [a, b] = ip.split("::"); const x = a ? a.split(":") : [], y = b ? b.split(":") : []; return [...x, ...Array(Math.max(0, 8 - x.length - y.length)).fill("0"), ...y]; })() : ip.split(":");
  return full.slice(0, 4).map((s) => s.toLowerCase()).join(":") + "::/64";
}

/** Minutos de uso de um pedaço de áudio, pelo tamanho (WAV 16 kHz mono = 32 KB/s; outros formatos: conta mais, por segurança). */
export const audioCost = (bytes, mime) => Math.max(0.05, round(bytes / (/wav/.test(mime || "") ? 32000 : 8000) / 60));

export const fmtMin = (n) => (Math.round(n * 10) / 10).toLocaleString("pt-BR");

// ----- Armazenamento em memória (testes e modo sem Durable Object) -----
export function createMemoryStorage() {
  const m = new Map();
  return {
    async get(k) { return m.get(k); },
    async put(k, v) { m.set(k, v); },
    async delete(keys) { for (const k of [].concat(keys)) m.delete(k); },
    async list({ prefix = "" } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix))); },
  };
}

/** Durable Object: um só, com todos os contadores do dia. Rotas: /charge (soma, devolve ou só consulta) e /bad (códigos errados). */
export class UsageCounter {
  constructor(state) { this.storage = state.storage; }

  async purge(prefix, metaKey, current) {
    if ((await this.storage.get(metaKey)) === current) return;
    const old = [...(await this.storage.list({ prefix })).keys()];
    for (let i = 0; i < old.length; i += 100) await this.storage.delete(old.slice(i, i + 100));
    await this.storage.put(metaKey, current);
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const b = await request.json().catch(() => ({}));
    if (path === "/bad") {
      await this.purge("b:", "meta:hour", b.hour);
      const key = `b:${b.ip}`, n = ((await this.storage.get(key)) || 0) + 1;
      await this.storage.put(key, n);
      return Response.json({ n });
    }
    // /charge: cost > 0 soma (se couber), cost < 0 devolve, cost = 0 só consulta
    await this.purge("u:", "meta:day", b.day);
    const ipKeyName = `u:ip:${b.ip}`, siteKeyName = "u:site";
    const ipUsed = (await this.storage.get(ipKeyName)) || 0, siteUsed = (await this.storage.get(siteKeyName)) || 0;
    const cost = Number(b.cost) || 0;
    if (cost > 0) {
      const scope = ipUsed + cost > b.ipLimit ? "ip" : siteUsed + cost > b.siteLimit ? "site" : null;
      if (scope) return Response.json({ ok: false, scope, ipUsed, siteUsed });
    }
    if (cost !== 0) {
      await this.storage.put(ipKeyName, Math.max(0, round(ipUsed + cost)));
      await this.storage.put(siteKeyName, Math.max(0, round(siteUsed + cost)));
    }
    return Response.json({ ok: true, ipUsed: Math.max(0, round(ipUsed + cost)), siteUsed: Math.max(0, round(siteUsed + cost)) });
  }
}

// Sem o binding USAGE: um contador na memória do Worker.
const memCounter = new UsageCounter({ storage: createMemoryStorage() });
async function callCounter(env, path, body) {
  const req = new Request("https://usage.internal" + path, { method: "POST", body: JSON.stringify(body) });
  if (env.USAGE) return (await env.USAGE.get(env.USAGE.idFromName("global")).fetch(req)).json();
  return (await memCounter.fetch(req)).json();
}

// Compara sem revelar, pelo tempo, quantas letras acertou.
async function safeEqual(a, b) {
  const h = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([h(a), h(b)]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export const unlimitedCodes = (env) => String(env.UNLIMITED_CODES || "").split(/[,\n]/).map((s) => s.trim()).filter((s) => s.length >= 8);
const limitsOf = (env) => ({ ipMin: Number(env.DAILY_LIMIT_IP_MIN) || DEFAULTS.ipMin, siteMin: Number(env.DAILY_LIMIT_SITE_MIN) || DEFAULTS.siteMin });

/**
 * Prepara o controle de limite para um pedido. Devolve { blocked } (uma Response, se deve barrar já)
 * ou { unlimited, codeGiven, codeValid, charge(cost), refund(cost), quota() }.
 */
export async function limiter(env, req, headers, json) {
  const ip = ipKey(req.headers.get("CF-Connecting-IP"));
  const given = (req.headers.get("X-Unlimited-Code") || "").trim().slice(0, 200);
  let codeValid = false;
  if (given) {
    for (const c of unlimitedCodes(env)) if (await safeEqual(given, c)) codeValid = true;
    if (!codeValid) {
      const hour = new Date().toISOString().slice(0, 13);
      try {
        const { n } = await callCounter(env, "/bad", { hour, ip });
        if (n > MAX_BAD_CODES) return { blocked: json({ error: "Muitas tentativas de código. Tente novamente em 1 hora.", code: "bad_code" }, 429, headers) };
      } catch (_) { /* contador fora do ar: segue como pessoa comum */ }
    }
  }
  const lim = limitsOf(env), day = dayKey();
  const call = (cost) => callCounter(env, "/charge", { day, ip, cost, ipLimit: lim.ipMin, siteLimit: lim.siteMin });
  const down = () => json({ error: "O contador de uso não respondeu. Tente de novo em instantes.", code: "usage_down" }, 503, headers);
  return {
    unlimited: codeValid, codeGiven: !!given, codeValid,
    /** Soma o uso. Devolve null se pode seguir, ou a Response de recusa. */
    async charge(cost) {
      if (codeValid) return null;
      let r;
      try { r = await call(cost); } catch (_) { return env.USAGE ? down() : null; }
      if (r.ok) return null;
      const msg = r.scope === "site"
        ? "O limite de uso do site para hoje foi atingido. Volte amanhã."
        : `Você chegou ao limite de hoje (${fmtMin(lim.ipMin)} minutos de uso). Volte amanhã ou use um código de liberação.`;
      return json({ error: msg, code: "daily_limit", scope: r.scope, limit: lim.ipMin, used: r.ipUsed, reset_at: resetAt() }, 429, headers);
    },
    async refund(cost) { if (!codeValid) { try { await call(-cost); } catch (_) { /* melhor cobrar a mais do que falhar */ } } },
    async quota() {
      let r = { ipUsed: 0, siteUsed: 0 };
      try { r = await call(0); } catch (_) { /* mostra zero */ }
      return {
        unlimited: codeValid, code_given: !!given, code_valid: codeValid,
        limit: lim.ipMin, used: r.ipUsed, remaining: Math.max(0, round(lim.ipMin - r.ipUsed)),
        site_full: r.siteUsed >= lim.siteMin, reset_at: resetAt(),
      };
    },
  };
}

/** Para o ?status: o que está ligado, sem valores. */
export const limitsStatus = (env) => ({
  contador_ligado: !!env.USAGE,
  limite_por_pessoa_min: limitsOf(env).ipMin,
  limite_do_site_min: limitsOf(env).siteMin,
  codigos_de_liberacao: unlimitedCodes(env).length,
});
