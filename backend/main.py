import asyncio
import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import uuid
import urllib.request
import wave
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import docx
from docx.table import Table
import pdfplumber
from piper import PiperVoice
from pydantic import BaseModel, Field
import library
import remarks

BASE_DIR = Path(__file__).parent
MODELS_DIR = BASE_DIR / "models"
STATIC_DIR = BASE_DIR / "static"
AUDIO_DIR = STATIC_DIR / "audio"
FRONTEND_DIR = BASE_DIR / "frontend"
if not FRONTEND_DIR.exists():
    FRONTEND_DIR = BASE_DIR.parent / "frontend"

PROCESSING_WORKERS = max(1, int(os.getenv("PROCESSING_WORKERS", "2")))
MAX_PENDING_DOCUMENTS = max(PROCESSING_WORKERS, int(os.getenv("MAX_PENDING_DOCUMENTS", "8")))
MAX_UPLOAD_BYTES = max(1, int(os.getenv("MAX_UPLOAD_MB", "20"))) * 1024 * 1024
MAX_REMARK_BYTES = max(1, int(os.getenv("MAX_REMARK_MB", "15"))) * 1024 * 1024
logger = logging.getLogger(__name__)

MODEL_PATH = MODELS_DIR / "ro_RO-mihai-medium.onnx"
CONFIG_PATH = MODELS_DIR / "ro_RO-mihai-medium.onnx.json"

MODEL_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/ro/ro_RO/mihai/medium/ro_RO-mihai-medium.onnx"
CONFIG_URL = MODEL_URL + ".json"

AUDIO_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # A dedicated pool keeps document work away from the HTTP event loop and
    # from Starlette's shared pool (also used to serve existing audio files).
    pool = ThreadPoolExecutor(max_workers=PROCESSING_WORKERS, thread_name_prefix="document")
    app.state.processing_pool = pool
    app.state.pending_documents = 0
    try:
        await asyncio.get_running_loop().run_in_executor(pool, get_voice)
        yield
    finally:
        await asyncio.to_thread(pool.shutdown, wait=True)


app = FastAPI(title="Text în voce", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_voices = threading.local()
_model_lock = threading.Lock()


def _download_if_missing() -> None:
    with _model_lock:
        for url, path in ((MODEL_URL, MODEL_PATH), (CONFIG_URL, CONFIG_PATH)):
            if not path.exists():
                # Publish only complete downloads, even when two workers start.
                partial = path.with_suffix(path.suffix + ".part")
                try:
                    urllib.request.urlretrieve(url, partial)
                    partial.replace(path)
                finally:
                    partial.unlink(missing_ok=True)


def get_voice() -> PiperVoice:
    # Reuse one independent inference session per worker.
    if not hasattr(_voices, "voice"):
        _download_if_missing()
        _voices.voice = PiperVoice.load(str(MODEL_PATH), config_path=str(CONFIG_PATH))
    return _voices.voice


SENTENCE_RE = re.compile(r"(?<=[.!?])\s+(?=[A-ZĂÂÎȘȚ0-9\"„])")


STYLE_KEYS = ("hl", "b", "i", "u")


def _run(text: str, **style) -> dict:
    return {"t": text, **{k: v for k, v in style.items() if v and k in STYLE_KEYS}}


def _style_of(run: dict) -> tuple:
    return tuple(run.get(k) for k in STYLE_KEYS)


def split_styled_sentences(runs: list[dict]) -> list[tuple[str, list[dict]]]:
    """Split a block (list of styled runs) into sentences, keeping per-char styles.

    Returns [(sentence_text, runs)] where runs is [] if nothing is styled.
    """
    chars: list[tuple[str, tuple]] = []
    for run in runs:
        style = _style_of(run)
        for ch in run["t"]:
            if ch.isspace():
                if chars and chars[-1][0] == " ":
                    continue
                chars.append((" ", style))
            else:
                chars.append((ch, style))
    while chars and chars[0][0] == " ":
        chars.pop(0)
    while chars and chars[-1][0] == " ":
        chars.pop()
    if not chars:
        return []

    text = "".join(c for c, _ in chars)
    out = []
    start = 0
    bounds = [(m.start(), m.end()) for m in SENTENCE_RE.finditer(text)]
    for b_start, b_end in bounds + [(len(text), len(text))]:
        seg = chars[start:b_start]
        if seg:
            grouped: list[dict] = []
            prev = None
            for ch, style in seg:
                if style == prev:
                    grouped[-1]["t"] += ch
                else:
                    grouped.append({"t": ch, **{k: v for k, v in zip(STYLE_KEYS, style) if v}})
                    prev = style
            styled = any(_style_of(r) != (None,) * len(STYLE_KEYS) for r in grouped)
            out.append(("".join(c for c, _ in seg), grouped if styled else []))
        start = b_end
    return out


def _extract_blocks_txt(text: str) -> list[dict]:
    blocks = []
    for para in re.split(r"\n\s*\n", text):
        joined = " ".join(line.strip() for line in para.splitlines() if line.strip()).strip()
        if joined:
            blocks.append({"type": "paragraph", "runs": [_run(joined)]})
    return blocks


W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
HIGHLIGHT_XML = {
    "yellow": "#ffff00",
    "green": "#00ff00",
    "cyan": "#00ffff",
    "magenta": "#ff00ff",
    "blue": "#0000ff",
    "red": "#ff0000",
    "darkBlue": "#000080",
    "darkCyan": "#008080",
    "darkGreen": "#008000",
    "darkMagenta": "#800080",
    "darkRed": "#800000",
    "darkYellow": "#808000",
    "darkGray": "#808080",
    "lightGray": "#c0c0c0",
    "black": "#000000",
}


def _docx_run_highlight(run) -> str | None:
    # Read the XML directly: python-docx raises on values like w:val="none".
    rpr = run._r.rPr
    if rpr is None:
        return None
    highlight = rpr.find(f"{W_NS}highlight")
    if highlight is not None:
        val = highlight.get(f"{W_NS}val")
        if val and val != "none":
            return HIGHLIGHT_XML.get(val, "#ffff00")
    shd = rpr.find(f"{W_NS}shd")
    if shd is not None:
        fill = shd.get(f"{W_NS}fill")
        if fill and re.fullmatch(r"[0-9A-Fa-f]{6}", fill) and fill.lower() != "ffffff":
            return "#" + fill.lower()
    return None


def _docx_paragraph_runs(p) -> list[dict]:
    try:
        runs = [
            _run(r.text, hl=_docx_run_highlight(r), b=r.bold, i=r.italic, u=bool(r.underline))
            for r in p.runs
            if r.text
        ]
    except Exception:
        # Odd formatting must never block reading the text itself.
        return [_run(p.text)]
    # Runs inside hyperlinks etc. are not in p.runs; don't lose text if so.
    if "".join(r["t"] for r in runs).strip() != p.text.strip():
        return [_run(p.text)]
    return runs


def _extract_blocks_docx(content: bytes) -> list[dict]:
    tmp_path = BASE_DIR / f"tmp_{uuid.uuid4().hex}.docx"
    tmp_path.write_bytes(content)
    try:
        document = docx.Document(str(tmp_path))
        blocks = []
        for p in document.iter_inner_content():
            if isinstance(p, Table):
                for row in p.rows:
                    cells_text = " | ".join(c.text.strip() for c in row.cells if c.text.strip())
                    if cells_text:
                        blocks.append({"type": "paragraph", "runs": [_run(cells_text)]})
                continue
            text = p.text.strip()
            if not text:
                continue
            runs = _docx_paragraph_runs(p)
            style_name = (p.style.name or "").lower() if p.style else ""
            if "heading" in style_name or "title" in style_name:
                match = re.search(r"(\d+)", style_name)
                level = min(int(match.group(1)), 6) if match else 1
                blocks.append({"type": "heading", "level": level, "runs": runs})
            else:
                blocks.append({"type": "paragraph", "runs": runs})
        return blocks
    finally:
        tmp_path.unlink(missing_ok=True)


def _pdf_fill_hex(color) -> str | None:
    """Hex for a saturated (non white/gray/black) fill colour, else None."""
    if not isinstance(color, (tuple, list)):
        return None
    if len(color) == 3:
        r, g, b = color
    elif len(color) == 4:
        c, m, y, k = color
        r, g, b = (1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)
    else:
        return None
    if max(r, g, b) - min(r, g, b) < 0.3:
        return None
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


def _pdf_highlight_rects(page) -> list[tuple[float, float, float, float, str]]:
    rects = []
    for r in page.rects:
        if not r.get("fill"):
            continue
        hex_color = _pdf_fill_hex(r.get("non_stroking_color"))
        # Skip big filled areas (backgrounds, table cells), keep text-sized marks.
        if hex_color and r["height"] < 40 and r["width"] < page.width * 0.95:
            rects.append((r["x0"], r["top"], r["x1"], r["bottom"], hex_color))
    return rects


def _pdf_word_run(w: dict, rects) -> dict:
    font = (w.get("fontname") or "").lower()
    cx, cy = (w["x0"] + w["x1"]) / 2, (w["top"] + w["bottom"]) / 2
    hl = next((c for x0, t, x1, bt, c in rects if x0 - 1 <= cx <= x1 + 1 and t - 1 <= cy <= bt + 1), None)
    return _run(
        w["text"],
        hl=hl,
        b="bold" in font or "black" in font,
        i="italic" in font or "oblique" in font,
    )


def _extract_blocks_pdf(content: bytes, metadata: dict | None = None) -> list[dict]:
    tmp_path = BASE_DIR / f"tmp_{uuid.uuid4().hex}.pdf"
    tmp_path.write_bytes(content)
    try:
        blocks: list[dict] = []
        pages_lines = []
        all_sizes = []

        with pdfplumber.open(str(tmp_path)) as pdf:
            if metadata is not None:
                metadata["page_count"] = len(pdf.pages)
            for page_no, page in enumerate(pdf.pages, start=1):
                words = page.extract_words(extra_attrs=["size", "fontname"])
                rects = _pdf_highlight_rects(page)
                if not words:
                    continue
                lines_by_top: dict[float, list] = {}
                for w in words:
                    key = round(w["top"])
                    lines_by_top.setdefault(key, []).append(w)
                page_lines = []
                for top in sorted(lines_by_top):
                    line_words = sorted(lines_by_top[top], key=lambda w: w["x0"])
                    text = " ".join(w["text"] for w in line_words)
                    line_runs = []
                    for w in line_words:
                        if line_runs:
                            line_runs.append(_run(" "))
                        line_runs.append(_pdf_word_run(w, rects))
                    avg_size = sum(w["size"] for w in line_words) / len(line_words)
                    page_lines.append({"top": top, "text": text, "runs": line_runs, "size": avg_size})
                    all_sizes.append(avg_size)
                if page_lines:
                    pages_lines.append((page_no, page_lines))

        if not all_sizes:
            return []

        body_size = Counter(round(s) for s in all_sizes).most_common(1)[0][0]

        for page_no, page_lines in pages_lines:
            body_gaps = [
                page_lines[i + 1]["top"] - page_lines[i]["top"]
                for i in range(len(page_lines) - 1)
                if page_lines[i]["size"] <= body_size * 1.15
                and page_lines[i + 1]["size"] <= body_size * 1.15
            ]
            # Regular single-line spacing is the smallest recurring gap; paragraph
            # breaks show up as outliers well above it. Median gets skewed with
            # few lines, so anchor on the minimum instead.
            normal_gap = min(body_gaps) if body_gaps else 15

            current_lines: list[list[dict]] = []
            current_is_heading = None
            prev_top = None

            def flush():
                if current_lines:
                    runs = []
                    for line_runs in current_lines:
                        if runs:
                            runs.append(_run(" "))
                        runs.extend(line_runs)
                    if "".join(r["t"] for r in runs).strip():
                        block = {"type": "paragraph", "runs": runs, "page": page_no}
                        if current_is_heading:
                            block.update(type="heading", level=2)
                        blocks.append(block)

            for line in page_lines:
                is_heading = line["size"] > body_size * 1.15
                gap = (line["top"] - prev_top) if prev_top is not None else 0
                starts_new_block = (
                    prev_top is None
                    or is_heading != current_is_heading
                    or gap > normal_gap * 1.6
                )
                if starts_new_block:
                    flush()
                    current_lines = [line["runs"]]
                    current_is_heading = is_heading
                else:
                    current_lines.append(line["runs"])
                prev_top = line["top"]
            flush()

        return blocks
    finally:
        tmp_path.unlink(missing_ok=True)


def extract_blocks(filename: str, content: bytes, metadata: dict | None = None) -> list[dict]:
    suffix = Path(filename).suffix.lower()

    if suffix == ".txt":
        return _extract_blocks_txt(content.decode("utf-8-sig", errors="ignore"))
    if suffix == ".docx":
        return _extract_blocks_docx(content)
    if suffix == ".pdf":
        return _extract_blocks_pdf(content, metadata)

    raise HTTPException(400, f"Format neacceptat: {suffix}. Folosește .docx, .pdf sau .txt.")


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    filename = file.filename or ""
    if Path(filename).suffix.lower() not in {".txt", ".pdf", ".docx"}:
        await file.close()
        raise HTTPException(400, "Format neacceptat. Folosește .docx, .pdf sau .txt.")
    if app.state.pending_documents >= MAX_PENDING_DOCUMENTS:
        await file.close()
        raise HTTPException(429, "Serverul procesează prea multe documente. Reîncearcă mai târziu.",
                            headers={"Retry-After": "5"})

    # Reserve before reading: concurrent uploads count toward the memory bound.
    app.state.pending_documents += 1
    submitted = False
    try:
        content = await file.read(MAX_UPLOAD_BYTES + 1)
        if len(content) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"Fișierul depășește limita de {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
        future = asyncio.get_running_loop().run_in_executor(
            app.state.processing_pool, process_document, filename, content
        )
        submitted = True

        def completed(job):
            app.state.pending_documents -= 1
            # Retrieve errors even if the HTTP client has disconnected.
            if not job.cancelled():
                job.exception()

        future.add_done_callback(completed)
        # Client cancellation must not free a slot while its thread still runs.
        return await asyncio.shield(future)
    finally:
        if not submitted:
            app.state.pending_documents -= 1
        await file.close()


def process_document(filename: str, content: bytes) -> dict:
    metadata = {}
    try:
        raw_blocks = extract_blocks(filename, content, metadata)
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Could not extract document text", exc_info=True)
        raise HTTPException(400, "Fișierul nu poate fi citit. Verifică formatul și integritatea lui.") from exc
    if not raw_blocks:
        raise HTTPException(400, "Nu s-a găsit text în fișier.")

    voice = get_voice()
    session_id = uuid.uuid4().hex[:12]
    session_dir = AUDIO_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    try:
        result = _synthesize_document(raw_blocks, voice, session_id, session_dir,
                                    content if Path(filename).suffix.lower() == ".pdf" else None,
                                    metadata.get("page_count"), filename)
        library.register(AUDIO_DIR, result)
        return result
    except Exception as exc:
        shutil.rmtree(session_dir, ignore_errors=True)
        if isinstance(exc, HTTPException):
            raise
        logger.exception("Document synthesis failed")
        raise HTTPException(500, "Generarea audio a eșuat. Reîncearcă mai târziu.") from exc


def _synthesize_document(raw_blocks: list[dict], voice: PiperVoice,
                         session_id: str, session_dir: Path, original_pdf: bytes | None = None,
                         page_count: int | None = None, filename: str = "") -> dict:
    sentences = []
    blocks = []
    global_index = 0
    for raw_block in raw_blocks:
        block_sentences = split_styled_sentences(raw_block["runs"])
        if not block_sentences:
            continue

        indices = []
        for sentence, sentence_runs in block_sentences:
            wav_path = session_dir / f"{global_index}.wav"
            with wave.open(str(wav_path), "wb") as wav_file:
                voice.synthesize(sentence, wav_file)
            with wave.open(str(wav_path), "rb") as wav_file:
                frames = wav_file.getnframes()
                rate = wav_file.getframerate()
                duration = frames / float(rate) if rate else 0.0
            entry = {
                "index": global_index,
                "text": sentence,
                "audio_url": f"/audio/{session_id}/{global_index}.wav",
                "duration": duration,
            }
            if sentence_runs:
                entry["runs"] = sentence_runs
            if raw_block.get("page"):
                entry["page"] = raw_block["page"]
            sentences.append(entry)
            indices.append(global_index)
            global_index += 1

        block_out = {"type": raw_block["type"], "sentence_indices": indices}
        if raw_block.get("level"):
            block_out["level"] = raw_block["level"]
        if raw_block.get("page"):
            block_out["page"] = raw_block["page"]
        blocks.append(block_out)

    if not sentences:
        raise HTTPException(400, "Nu s-a găsit text în fișier.")

    mp3_url = _build_mp3(session_dir, len(sentences))

    original_url = None
    if original_pdf is not None:
        (session_dir / "original.pdf").write_bytes(original_pdf)
        original_url = f"/audio/{session_id}/original.pdf"

    result = {
        "session_id": session_id,
        "filename": Path(filename.replace("\\", "/")).name[:250],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "sentences": sentences,
        "blocks": blocks,
        "mp3_url": mp3_url,
        "original_url": original_url,
        "page_count": page_count,
    }
    partial = session_dir / "meta.json.part"
    partial.write_text(json.dumps(result), encoding="utf-8")
    partial.replace(session_dir / "meta.json")
    return result


SESSION_ID_RE = re.compile(r"^[0-9a-f]{6,32}$")


@app.get("/api/library")
def get_library():
    return {"documents": library.list_documents(AUDIO_DIR)}


class DocumentName(BaseModel):
    name: str = Field(min_length=1, max_length=200)


@app.patch("/api/library/{session_id}")
def rename_document(session_id: str, body: DocumentName):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Introdu un nume pentru document.")
    if not SESSION_ID_RE.fullmatch(session_id):
        raise HTTPException(404, "Document negăsit.")
    item = library.rename(AUDIO_DIR, session_id, name)
    if item is None:
        raise HTTPException(404, "Document negăsit.")
    return item


@app.delete("/api/library/{session_id}", status_code=204)
def delete_document(session_id: str):
    if not library.delete(AUDIO_DIR, session_id):
        raise HTTPException(404, "Document negăsit.")
    return Response(status_code=204)


@app.get("/api/session/{session_id}")
def get_session(session_id: str):
    if not SESSION_ID_RE.fullmatch(session_id):
        raise HTTPException(404, "Sesiune negăsită sau expirată.")
    meta_path = AUDIO_DIR / session_id / "meta.json"
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        raise HTTPException(404, "Sesiune negăsită sau expirată.")


def _document_dir(session_id: str) -> Path:
    """Directory of an existing document, or 404."""
    directory = AUDIO_DIR / session_id
    if not SESSION_ID_RE.fullmatch(session_id) or not (directory / "meta.json").is_file():
        raise HTTPException(404, "Sesiune negăsită sau expirată.")
    return directory


@app.get("/api/session/{session_id}/remarks")
def get_remarks(session_id: str):
    return {"remarks": remarks.list_remarks(_document_dir(session_id))}


@app.post("/api/session/{session_id}/remarks", status_code=201)
async def add_remark(session_id: str, audio: UploadFile = File(...),
                     sentence_index: int = Form(..., ge=0),
                     duration: float | None = Form(None, ge=0, le=3600),
                     author: str = Form("", max_length=60)):
    directory = _document_dir(session_id)
    try:
        extension = remarks.extension_for(audio.content_type)
        if extension is None:
            raise HTTPException(415, "Format audio neacceptat pentru remarcă.")
        content = await audio.read(MAX_REMARK_BYTES + 1)
    finally:
        await audio.close()
    if len(content) > MAX_REMARK_BYTES:
        raise HTTPException(413, f"Remarca depășește limita de {MAX_REMARK_BYTES // (1024 * 1024)} MB.")
    if not content:
        raise HTTPException(400, "Înregistrarea este goală.")
    try:
        meta = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        raise HTTPException(404, "Documentul a fost șters.")
    if sentence_index >= len(meta.get("sentences", [])):
        raise HTTPException(400, "Paragraful nu există în document.")
    try:
        return await asyncio.to_thread(remarks.add, directory, session_id, sentence_index,
                                       content, extension, duration, author.strip())
    except FileNotFoundError:
        raise HTTPException(404, "Documentul a fost șters.")


@app.delete("/api/session/{session_id}/remarks/{remark_id}", status_code=204)
def delete_remark(session_id: str, remark_id: str):
    if not remarks.remove(_document_dir(session_id), remark_id):
        raise HTTPException(404, "Remarcă negăsită.")
    return Response(status_code=204)


def _build_mp3(session_dir: Path, sentence_count: int) -> str | None:
    combined_path = session_dir / "full.wav"
    mp3_path = session_dir / "full.mp3"

    try:
        with wave.open(str(combined_path), "wb") as out_wav:
            for index in range(sentence_count):
                with wave.open(str(session_dir / f"{index}.wav"), "rb") as in_wav:
                    if index == 0:
                        out_wav.setparams(in_wav.getparams())
                    while chunk := in_wav.readframes(65536):
                        out_wav.writeframes(chunk)

        subprocess.run(
            ["ffmpeg", "-y", "-i", str(combined_path), "-codec:a", "libmp3lame", "-qscale:a", "2", str(mp3_path)],
            check=True,
            timeout=300,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        logger.warning("MP3 export failed for %s", session_dir.name, exc_info=True)
        mp3_path.unlink(missing_ok=True)
        return None
    finally:
        combined_path.unlink(missing_ok=True)

    return f"/audio/{session_dir.name}/full.mp3"


mimetypes.add_type("application/manifest+json", ".webmanifest")

# Generated audio never changes once written (ids are random), so phones may keep
# it and avoid downloading the same sentence again on replay or seek.
CACHEABLE_AUDIO = {".wav", ".mp3", ".webm", ".ogg", ".m4a", ".aac"}


class AudioFiles(StaticFiles):
    async def get_response(self, path, scope):
        if any(part.startswith(".") for part in path.replace("\\", "/").split("/")):
            raise HTTPException(404, "Fișier negăsit.")
        response = await super().get_response(path, scope)
        if response.status_code in (200, 206) and Path(path).suffix.lower() in CACHEABLE_AUDIO:
            response.headers["Cache-Control"] = "public, max-age=86400"
        return response


class FrontendFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        # Revalidate on every load (cheap 304 via ETag) so a phone that kept the
        # page open never mixes a new index.html with an old script.js.
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/audio", AudioFiles(directory=str(AUDIO_DIR)), name="audio")
app.mount("/", FrontendFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
