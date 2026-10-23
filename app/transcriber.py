"""Pipeline: extrai áudio (ffmpeg) -> transcreve (Whisper) -> corrige ortografia e organiza (LLM)."""
import json
import os
import subprocess
import tempfile
from pathlib import Path

STT_MODEL = os.getenv("TRANSCRIBY_STT_MODEL", "whisper-1")
MOCK = os.getenv("TRANSCRIBY_MOCK", "0") == "1"

# "local" = Whisper rodando no próprio computador (grátis, sem API); "openai" = API da OpenAI.
ENGINE = os.getenv("TRANSCRIBY_ENGINE") or ("openai" if os.getenv("OPENAI_API_KEY") else "local")
LOCAL_MODEL = os.getenv("TRANSCRIBY_WHISPER_MODEL", "large-v3-turbo")
# Revisão ortográfica: usa a OpenAI se houver chave, ou um servidor local compatível (ex.: Ollama).
LLM_BASE_URL = os.getenv("TRANSCRIBY_LLM_BASE_URL")  # ex.: http://localhost:11434/v1
LLM_MODEL = os.getenv("TRANSCRIBY_LLM_MODEL") or (
    "qwen2.5:7b" if LLM_BASE_URL and not os.getenv("OPENAI_API_KEY") else "gpt-4.1-mini")
USE_LLM = bool(os.getenv("OPENAI_API_KEY") or LLM_BASE_URL)

MAX_UPLOAD_BYTES = 24 * 1024 * 1024   # limite da API de transcrição é 25 MB
CHUNK_SECONDS = 600                   # pedaços de 10 min quando o áudio é grande
SEGMENTS_PER_BATCH = 60

_client = None


def client():
    global _client
    if _client is None:
        from openai import OpenAI
        if LLM_BASE_URL and not os.getenv("OPENAI_API_KEY"):
            _client = OpenAI(base_url=LLM_BASE_URL, api_key="local")
        else:
            _client = OpenAI()
    return _client


# ---------- áudio ----------

def _run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return float(out or 0)


def extract_audio(src: Path, workdir: Path) -> Path:
    """Converte qualquer áudio/vídeo para MP3 mono 16 kHz (leve e ideal para fala)."""
    dst = workdir / "audio.mp3"
    _run(["ffmpeg", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", str(dst)])
    return dst


def split_audio(audio: Path, workdir: Path):
    """Devolve [(arquivo, deslocamento_em_segundos)]."""
    if audio.stat().st_size <= MAX_UPLOAD_BYTES:
        return [(audio, 0.0)]
    total = duration(audio)
    parts, start, i = [], 0.0, 0
    while start < total:
        part = workdir / f"part{i:03}.mp3"
        _run(["ffmpeg", "-y", "-ss", str(start), "-t", str(CHUNK_SECONDS), "-i", str(audio),
              "-c", "copy", str(part)])
        parts.append((part, start))
        start += CHUNK_SECONDS
        i += 1
    return parts


# ---------- transcrição ----------

def _transcribe_file(path: Path, language: str | None, prompt: str | None):
    kwargs = dict(model=STT_MODEL, response_format="verbose_json",
                  timestamp_granularities=["segment"])
    if language:
        kwargs["language"] = language
    if prompt:
        kwargs["prompt"] = prompt
    with open(path, "rb") as f:
        resp = client().audio.transcriptions.create(file=f, **kwargs)
    data = resp.model_dump() if hasattr(resp, "model_dump") else dict(resp)
    segs = data.get("segments") or []
    if not segs and data.get("text"):
        segs = [{"start": 0.0, "end": duration(path), "text": data["text"]}]
    return [{"start": float(s["start"]), "end": float(s["end"]), "text": s["text"].strip()} for s in segs]


_local_model = None


def transcribe_local(audio: Path, language: str | None, on_progress=lambda p, m: None):
    """Transcrição 100% local com faster-whisper (baixa o modelo na primeira vez)."""
    global _local_model
    from faster_whisper import WhisperModel
    if _local_model is None:
        on_progress(10, f"Carregando o modelo {LOCAL_MODEL} (na primeira vez ele é baixado)…")
        _local_model = WhisperModel(LOCAL_MODEL, device="auto", compute_type="auto")
    segs_iter, info = _local_model.transcribe(str(audio), language=language, vad_filter=True,
                                              beam_size=5)
    total = info.duration or 1
    segments = []
    for s in segs_iter:
        segments.append({"start": s.start, "end": s.end, "text": s.text.strip()})
        on_progress(15 + int(70 * min(s.end / total, 1)), f"Transcrevendo… {int(100 * min(s.end / total, 1))}%")
    return segments


def transcribe(audio: Path, workdir: Path, language: str | None, on_progress=lambda p, m: None):
    segments, prev_text = [], None
    parts = split_audio(audio, workdir)
    for idx, (part, offset) in enumerate(parts):
        on_progress(15 + int(50 * idx / len(parts)), f"Transcrevendo parte {idx + 1} de {len(parts)}…")
        segs = _transcribe_file(part, language, prev_text)
        for s in segs:
            s["start"] += offset
            s["end"] += offset
        segments.extend(segs)
        if segs:
            prev_text = " ".join(s["text"] for s in segs)[-500:]  # contexto para a próxima parte
    return segments


# ---------- correção com LLM ----------

FIX_PROMPT = """Você é um revisor ortográfico profissional. Recebe trechos numerados de uma transcrição automática.
Para CADA trecho, corrija ortografia, acentuação, pontuação, letras maiúsculas e palavras claramente mal reconhecidas,
mantendo o mesmo idioma e o sentido original. NÃO resuma, NÃO junte nem separe trechos, NÃO traduza, NÃO acrescente conteúdo.
Responda somente com um JSON no formato {"1": "texto corrigido", "2": "..."} contendo exatamente as mesmas chaves."""

ORGANIZE_PROMPT = """Você recebe o texto revisado de uma transcrição. Organize-o em parágrafos bem divididos por assunto,
corrigindo qualquer erro de ortografia ou pontuação que restar. Mantenha todas as palavras e o sentido; não resuma, não traduza,
não acrescente títulos nem comentários. Responda apenas com o texto final, com parágrafos separados por uma linha em branco."""


def _chat(system: str, user: str, json_mode=False) -> str:
    kwargs = {"response_format": {"type": "json_object"}} if json_mode else {}
    resp = client().chat.completions.create(
        model=LLM_MODEL, temperature=0,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        **kwargs,
    )
    return resp.choices[0].message.content


def correct_segments(segments, on_progress=lambda p, m: None):
    batches = [segments[i:i + SEGMENTS_PER_BATCH] for i in range(0, len(segments), SEGMENTS_PER_BATCH)]
    for b, batch in enumerate(batches):
        on_progress(65 + int(20 * b / max(len(batches), 1)), "Corrigindo ortografia e pontuação…")
        payload = {str(i + 1): s["text"] for i, s in enumerate(batch)}
        try:
            fixed = json.loads(_chat(FIX_PROMPT, json.dumps(payload, ensure_ascii=False), json_mode=True))
        except Exception:
            continue  # em caso de falha mantém o texto original do trecho
        for i, s in enumerate(batch):
            new = fixed.get(str(i + 1))
            if isinstance(new, str) and new.strip():
                s["text"] = new.strip()
    return segments


def paragraphs_by_pause(segments, pause=1.5, max_chars=700):
    """Sem IA: abre um novo parágrafo em pausas longas na fala ou quando o parágrafo fica grande."""
    paragraphs, cur, last_end = [], "", None
    for s in segments:
        gap = s["start"] - last_end if last_end is not None else 0
        ends_sentence = cur.rstrip().endswith((".", "!", "?"))
        if cur and ends_sentence and (gap >= pause or len(cur) >= max_chars):
            paragraphs.append(cur.strip())
            cur = ""
        cur += s["text"] + " "
        last_end = s["end"]
    if cur.strip():
        paragraphs.append(cur.strip())
    return paragraphs


def organize_text(segments, on_progress=lambda p, m: None):
    on_progress(88, "Organizando o texto em parágrafos…")
    full = " ".join(s["text"] for s in segments)
    # divide em blocos de ~6000 caracteres no fim de uma frase
    blocks, cur = [], ""
    for s in segments:
        cur += s["text"] + " "
        if len(cur) > 6000 and cur.rstrip().endswith((".", "!", "?")):
            blocks.append(cur)
            cur = ""
    if cur.strip():
        blocks.append(cur)
    paragraphs = []
    for block in blocks or [full]:
        try:
            out = _chat(ORGANIZE_PROMPT, block)
            paragraphs.extend(p for p in out.split("\n\n") if p.strip())
        except Exception:
            paragraphs.append(block)
    return paragraphs


# ---------- modo demonstração ----------

def _mock(audio: Path):
    total = max(duration(audio), 6.0)
    sample = [
        "Olá, seja bem-vindo ao Transcriby.",
        "Este é um texto de demonstração, gerado sem chamar nenhuma API.",
        "Quando você configurar a chave da OpenAI, aqui aparecerá a transcrição real do seu arquivo, "
        "com ortografia e pontuação revisadas automaticamente.",
        "Você pode baixar o resultado em SRT, para legendas, ou em TXT, como texto corrido.",
    ]
    step = total / len(sample)
    segs = [{"start": i * step, "end": (i + 1) * step, "text": t} for i, t in enumerate(sample)]
    return segs, [" ".join(sample[:2]), " ".join(sample[2:])]


# ---------- pipeline completo ----------

def process(src: Path, language: str | None, on_progress=lambda p, m: None, revise: bool = True):
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        on_progress(5, "Extraindo o áudio…")
        audio = extract_audio(src, workdir)
        if MOCK:
            on_progress(60, "Modo demonstração…")
            return _mock(audio)
        if ENGINE == "local":
            segments = transcribe_local(audio, language, on_progress)
        else:
            segments = transcribe(audio, workdir, language, on_progress)
        if not segments:
            return [], []
        if USE_LLM and revise:
            segments = correct_segments(segments, on_progress)
            paragraphs = organize_text(segments, on_progress)
        else:
            paragraphs = paragraphs_by_pause(segments)
        return segments, paragraphs
