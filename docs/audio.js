// Converte qualquer áudio ou vídeo em mono 16 kHz (Float32Array), que é o formato que o Whisper espera.
// Caminho 1 (principal): lê só a faixa de áudio do arquivo aos poucos, sem carregar o vídeo inteiro na memória.
//   Resolve o "Decoding failed" de vídeos do iPhone (.mov em HEVC), onde o decodeAudioData falha.
// Caminho 2 (reserva): o método antigo, decodeAudioData no arquivo inteiro.

const OUT_RATE = 16000;
const MB_URL = "https://cdn.jsdelivr.net/npm/mediabunny@1.61.3/+esm";

// Reamostragem por média ponderada, aos poucos (a memória não cresce com o tamanho do arquivo de entrada).
export function makeResampler(inRate, outRate = OUT_RATE) {
  const ratio = inRate / outRate;
  const SIZE = 1 << 20;
  const chunks = [];
  let cur = new Float32Array(SIZE), curLen = 0, total = 0;
  let g = 0, k = 0, acc = 0, wsum = 0;
  const emit = v => {
    if (curLen === SIZE) { chunks.push(cur); cur = new Float32Array(SIZE); curLen = 0; }
    cur[curLen++] = v; total++;
  };
  return {
    push(mono) {
      if (ratio === 1) { for (let i = 0; i < mono.length; i++) emit(mono[i]); return; }
      for (let i = 0; i < mono.length; i++) {
        const s = mono[i];
        let a = g;
        const b = g + 1;
        g = b;
        while (a < b) {
          const binEnd = (k + 1) * ratio;
          const segEnd = b < binEnd ? b : binEnd;
          const w = segEnd - a;
          acc += s * w; wsum += w; a = segEnd;
          if (segEnd >= binEnd) { emit(wsum ? acc / wsum : 0); acc = 0; wsum = 0; k++; }
        }
      }
    },
    finish() {
      if (wsum > 0.5) emit(acc / wsum);
      const out = new Float32Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      out.set(cur.subarray(0, curLen), off);
      return out;
    },
  };
}

function toMono(buffer) {
  const n = buffer.numberOfChannels, len = buffer.length;
  if (n === 1) return buffer.getChannelData(0);
  const mono = new Float32Array(len);
  for (let c = 0; c < n; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / n;
  }
  return mono;
}

async function decodeStreaming(file, onProgress) {
  const { Input, BlobSource, ALL_FORMATS, AudioBufferSink } = await import(MB_URL);
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error("o arquivo não tem faixa de áudio");
  if (!(await track.canDecode())) throw new Error("este navegador não decodifica o áudio desse arquivo");
  let duration = 0;
  try { duration = await input.computeDuration(); } catch (_) { /* sem duração, só não mostra o progresso */ }

  let rs = null, rate = 0;
  for await (const item of new AudioBufferSink(track).buffers()) {
    const buf = item.buffer;
    if (!rs) { rate = buf.sampleRate; rs = makeResampler(rate); }
    else if (buf.sampleRate !== rate) throw new Error("a taxa de áudio muda no meio do arquivo");
    rs.push(toMono(buf));
    if (duration > 0 && onProgress) onProgress(Math.min(1, (item.timestamp + item.duration) / duration));
  }
  const out = rs ? rs.finish() : new Float32Array(0);
  if (!out.length) throw new Error("não saiu áudio da decodificação");
  return out;
}

async function decodeWhole(file) {
  const buf = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try { ctx = new AC({ sampleRate: OUT_RATE }); } catch (_) { ctx = new AC(); }
  try {
    const audio = await new Promise((res, rej) => ctx.decodeAudioData(buf, res, rej));
    const rs = makeResampler(audio.sampleRate);
    rs.push(toMono(audio));
    return rs.finish();
  } finally {
    ctx.close();
  }
}

export async function decodeToMono16k(file, onProgress) {
  let first = null;
  try {
    return await decodeStreaming(file, onProgress);
  } catch (e) {
    first = e;
    console.warn("Leitura por partes falhou, tentando o método antigo:", e);
  }
  try {
    return await decodeWhole(file);
  } catch (e) {
    const a = (first && (first.message || first)) || "";
    const b = e && (e.message || e) || "";
    throw new Error(a && b ? `${b}; antes: ${a}` : (b || a));
  }
}
