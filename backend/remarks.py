"""Audio remarks attached to paragraphs of a shared document.

Everything lives inside the document's session directory (`remarks.json` plus
`remarks/<id>.<ext>`), so removing the document directory removes its
remarks too, and the audio is served by the existing /audio static mount.
"""
import json
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

REMARK_ID_RE = re.compile(r"^[0-9a-f]{12}$")
# Browsers record in different containers: Chrome/Firefox webm or ogg, Safari mp4.
AUDIO_TYPES = {
    "audio/webm": "webm",
    "video/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
}
_lock = threading.Lock()


def extension_for(content_type: str | None) -> str | None:
    base = (content_type or "").split(";")[0].strip().lower()
    return AUDIO_TYPES.get(base)


def _index(directory: Path) -> Path:
    return directory / "remarks.json"


def _read(directory: Path) -> list[dict]:
    try:
        return json.loads(_index(directory).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _write(directory: Path, items: list[dict]) -> None:
    partial = directory / "remarks.json.part"
    partial.write_text(json.dumps(items), encoding="utf-8")
    partial.replace(_index(directory))


def list_remarks(directory: Path) -> list[dict]:
    with _lock:
        return _read(directory)


def add(directory: Path, session_id: str, sentence_index: int, content: bytes,
        extension: str, duration: float | None, author: str) -> dict:
    """Store one remark; raises FileNotFoundError if the document was deleted."""
    if not directory.is_dir():
        raise FileNotFoundError(directory)
    remark_id = uuid.uuid4().hex[:12]
    audio_dir = directory / "remarks"
    with _lock:
        audio_dir.mkdir(exist_ok=True)
        (audio_dir / f"{remark_id}.{extension}").write_bytes(content)
        item = {
            "id": remark_id,
            "sentence_index": sentence_index,
            "audio_url": f"/audio/{session_id}/remarks/{remark_id}.{extension}",
            "duration": duration,
            "author": author,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            _write(directory, _read(directory) + [item])
        except FileNotFoundError:
            # Document deleted while the remark was being stored.
            (audio_dir / f"{remark_id}.{extension}").unlink(missing_ok=True)
            raise
    return item


def remove(directory: Path, remark_id: str) -> bool:
    if not REMARK_ID_RE.fullmatch(remark_id):
        return False
    with _lock:
        items = _read(directory)
        kept = [item for item in items if item["id"] != remark_id]
        if len(kept) == len(items):
            return False
        _write(directory, kept)
        for path in (directory / "remarks").glob(f"{remark_id}.*"):
            path.unlink(missing_ok=True)
    return True
