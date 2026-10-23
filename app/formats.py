"""Geração dos arquivos de saída (SRT e TXT)."""
import re
import textwrap

MAX_LINE = 42      # caracteres por linha de legenda
MAX_LINES = 2      # linhas por bloco de legenda


def _ts(seconds: float) -> str:
    ms = int(round(max(seconds, 0) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def _split_cue(start: float, end: float, text: str):
    """Quebra um segmento longo em vários blocos, dividindo o tempo pelo tamanho do texto."""
    lines = textwrap.wrap(text, MAX_LINE)
    if len(lines) <= MAX_LINES:
        return [(start, end, "\n".join(lines))]
    groups = [lines[i:i + MAX_LINES] for i in range(0, len(lines), MAX_LINES)]
    total = sum(len(" ".join(g)) for g in groups)
    cues, t = [], start
    for g in groups:
        chunk = " ".join(g)
        dur = (end - start) * len(chunk) / total
        cues.append((t, t + dur, "\n".join(g)))
        t += dur
    return cues


def to_srt(segments) -> str:
    out, n = [], 1
    for seg in segments:
        text = seg["text"].strip()
        if not text:
            continue
        for start, end, body in _split_cue(seg["start"], seg["end"], text):
            out.append(f"{n}\n{_ts(start)} --> {_ts(end)}\n{body}\n")
            n += 1
    return "\n".join(out)


def to_txt(paragraphs) -> str:
    return "\n\n".join(p.strip() for p in paragraphs if p.strip()) + "\n"


# ---------- estilo CapCut: blocos curtos, sem pontuação (bom para levar a uma IA) ----------

CAPCUT_MAX_CHARS = 24   # caracteres por bloco


def strip_punct(text: str) -> str:
    text = re.sub(r"(?<!\d)[,.](?!\d)", " ", text)           # mantém 3,5 e 1.000
    text = re.sub(r"[!?;:\u2026\u2014\u2013\"'“”‘’()\[\]{}«»]+", " ", text)
    text = re.sub(r"(?<!\w)-|-(?!\w)", " ", text)            # hífen solto
    return re.sub(r"\s+", " ", text).strip()


def _capcut_chunks(words):
    chunks, cur = [], []
    for w in words:
        if cur and len(" ".join(cur + [w])) > CAPCUT_MAX_CHARS:
            chunks.append(" ".join(cur))
            cur = []
        cur.append(w)
    if cur:
        chunks.append(" ".join(cur))
    return chunks


def to_srt_capcut(segments) -> str:
    out, n = [], 1
    for seg in segments:
        chunks = _capcut_chunks(strip_punct(seg["text"]).split())
        if not chunks:
            continue
        total = sum(len(c) for c in chunks)
        t = seg["start"]
        for c in chunks:
            dur = (seg["end"] - seg["start"]) * len(c) / total
            out.append(f"{n}\n{_ts(t)} --> {_ts(t + dur)}\n{c}\n")
            n += 1
            t += dur
    return "\n".join(out)


def to_txt_plain(segments) -> str:
    return strip_punct(" ".join(s["text"] for s in segments)) + "\n"
