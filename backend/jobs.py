"""Small persistent status records; document work never runs in a polling request."""
import json
import re
import threading
import time
import uuid

JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
RETENTION_SECONDS = 7 * 24 * 3600
_lock = threading.RLock()


def _directory(root):
    directory = root / ".jobs"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def read(root, job_id):
    if not JOB_ID_RE.fullmatch(job_id):
        return None
    with _lock:
        try:
            return json.loads((_directory(root) / f"{job_id}.json").read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            return None


def update(root, job_id, **fields):
    with _lock:
        data = read(root, job_id) or {"job_id": job_id, "created_at": time.time()}
        data.update(fields, updated_at=time.time())
        path = _directory(root) / f"{job_id}.json"
        partial = path.with_suffix(".part")
        partial.write_text(json.dumps(data), encoding="utf-8")
        partial.replace(path)
        return data


def create(root, filename, job_id=None):
    return update(root, job_id or uuid.uuid4().hex, filename=filename, status="queued",
                  stage="queued", completed_sentences=0, total_sentences=0)


def recover(root):
    """One Uvicorn process owns the workers. A restart cannot resume in-memory input."""
    now = time.time()
    for path in (root / ".jobs").glob("*.json"):
        data = read(root, path.stem)
        if not isinstance(data, dict):
            continue
        if data.get("status") in {"queued", "processing"}:
            update(root, path.stem, status="failed", error_status=503,
                   error="Serverul a fost repornit. Încarcă din nou documentul.")
        elif now - data.get("updated_at", now) > RETENTION_SECONDS:
            path.unlink(missing_ok=True)
