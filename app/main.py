"""Servidor web do Transcriby."""
import shutil
import tempfile
import threading
import uuid
from urllib.parse import quote
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse

from . import formats, transcriber

ROOT = Path(__file__).resolve().parent.parent
app = FastAPI(title="Transcriby")
jobs: dict[str, dict] = {}
UPLOADS = Path(tempfile.gettempdir()) / "transcriby"
UPLOADS.mkdir(exist_ok=True)


def _worker(job_id: str, path: Path, language: str | None, style: str):
    job = jobs[job_id]

    def progress(pct, msg):
        job.update(progress=pct, message=msg)

    try:
        segments, paragraphs = transcriber.process(path, language, progress, revise=style == "completo")
        if not segments:
            raise RuntimeError("Nenhuma fala foi encontrada no arquivo.")
        if style == "completo":
            srt, txt = formats.to_srt(segments), formats.to_txt(paragraphs)
        else:
            srt, txt = formats.to_srt_capcut(segments), formats.to_txt_plain(segments)
        job.update(srt=srt, txt=txt, status="done", progress=100, message="Pronto!")
    except Exception as e:  # noqa: BLE001
        job.update(status="error", message=f"Erro: {e}")
    finally:
        path.unlink(missing_ok=True)


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.post("/api/jobs")
async def create_job(file: UploadFile = File(...), language: str = Form(""), style: str = Form("capcut")):
    job_id = uuid.uuid4().hex
    suffix = Path(file.filename or "").suffix[:10]
    dest = UPLOADS / f"{job_id}{suffix}"
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    name = Path(file.filename or "transcricao").stem
    jobs[job_id] = {"status": "running", "progress": 1, "message": "Arquivo recebido…", "name": name}
    threading.Thread(target=_worker, args=(job_id, dest, language or None, style), daemon=True).start()
    return {"id": job_id}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = jobs.get(job_id) or _404()
    return {k: job[k] for k in ("status", "progress", "message")} | (
        {"preview": job["srt"][:3000]} if job["status"] == "done" else {})


@app.get("/api/jobs/{job_id}/download")
def download(job_id: str, fmt: str = "txt"):
    job = jobs.get(job_id) or _404()
    if job["status"] != "done" or fmt not in ("srt", "txt"):
        raise HTTPException(400, "Resultado indisponível.")
    return PlainTextResponse(
        job[fmt], media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition":
                 f"attachment; filename=\"transcricao.{fmt}\"; filename*=UTF-8''{quote(job['name'])}.{fmt}"},
    )


def _404():
    raise HTTPException(404, "Trabalho não encontrado.")
