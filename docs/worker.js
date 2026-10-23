// Roda o Whisper dentro do navegador (Web Worker) usando Transformers.js
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.0";

env.allowLocalModels = false;
let asr = null, loadedKey = null;

const MODELS = {
  rapido: "Xenova/whisper-base",
  melhor: "Xenova/whisper-small",
};

async function load(model, post, mobile) {
  // No celular a placa de vídeo (WebGPU) com o modelo em precisão cheia estoura a memória e o navegador fecha a aba.
  // Lá usamos o processador com o modelo compactado (q8), que é mais lento mas bem mais leve.
  const device = (!mobile && self.navigator.gpu) ? "webgpu" : "wasm";
  const key = model + device;
  if (asr && loadedKey === key) return;
  post({ type: "status", pct: 2, msg: "Baixando o modelo de transcrição (só na primeira vez)…" });
  const files = {};
  const opts = {
    device,
    dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q8" } : "q8",
    progress_callback: p => {
      if (p.status === "progress" && p.file) {
        files[p.file] = p.progress;
        const vals = Object.values(files);
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        post({ type: "status", pct: 2 + Math.round(avg * 0.2), msg: `Baixando o modelo… ${Math.round(avg)}%` });
      }
    },
  };
  try {
    asr = await pipeline("automatic-speech-recognition", MODELS[model], opts);
  } catch (e) {
    if (device === "webgpu") {  // se a placa de vídeo falhar, cai para o processador
      asr = await pipeline("automatic-speech-recognition", MODELS[model], { ...opts, device: "wasm", dtype: "q8" });
    } else throw e;
  }
  loadedKey = key;
}

self.onmessage = async ({ data }) => {
  const post = m => self.postMessage(m);
  try {
    await load(data.model, post, !!data.mobile);
    const duration = data.audio.length / 16000;
    const totalChunks = Math.max(1, Math.ceil(duration / 20));
    let done = 0;
    post({ type: "status", pct: 25, msg: "Transcrevendo…" });
    const out = await asr(data.audio, {
      language: data.language || null,
      task: "transcribe",
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      chunk_callback: () => {
        done++;
        const pct = 25 + Math.min(70, Math.round(70 * done / totalChunks));
        post({ type: "status", pct, msg: `Transcrevendo… ${Math.min(100, Math.round(100 * done / totalChunks))}%` });
      },
    });
    const segments = (out.chunks || []).map(c => ({
      start: c.timestamp[0] ?? 0,
      end: c.timestamp[1] ?? duration,
      text: c.text,
    })).filter(s => s.text.trim());
    if (!segments.length && out.text) segments.push({ start: 0, end: duration, text: out.text });
    post({ type: "done", segments });
  } catch (e) {
    post({ type: "error", msg: String(e && e.message || e) });
  }
};
