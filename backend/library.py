"""Shared, persistent document catalogue; session content stays in its directory."""
import json
import logging
import re
import shutil
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

SESSION_ID_RE = re.compile(r"^[0-9a-f]{6,32}$")
_lock = threading.RLock()
logger = logging.getLogger(__name__)


def summary(data, directory):
    return {
        "session_id": directory.name,
        "name": data.get("filename") or f"Document {directory.name}",
        "created_at": data.get("created_at") or datetime.fromtimestamp(
            directory.stat().st_mtime, timezone.utc).isoformat(),
        "sentence_count": len(data.get("sentences", [])),
        "page_count": data.get("page_count"),
        "format": Path(data.get("filename") or "").suffix.lower().lstrip(".")
                  or ("pdf" if data.get("original_url") else "text"),
        "size_bytes": sum(p.stat().st_size for p in directory.iterdir() if p.is_file()),
    }


def _insert(db, item):
    db.execute("INSERT OR REPLACE INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)",
               tuple(item[key] for key in ("session_id", "name", "created_at",
                     "sentence_count", "page_count", "format", "size_bytes")))


@contextmanager
def catalogue(root):
    # This directory is in the persisted audio volume, but cannot be served
    # by the /audio static mount. Short transactions never contain TTS work.
    with _lock:
        private = root / ".library"
        private.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(private / "catalogue.sqlite3", timeout=30)
        db.row_factory = sqlite3.Row
        try:
            db.execute("""CREATE TABLE IF NOT EXISTS documents (
                session_id TEXT PRIMARY KEY, name TEXT NOT NULL,
                created_at TEXT NOT NULL, sentence_count INTEGER NOT NULL,
                page_count INTEGER, format TEXT NOT NULL, size_bytes INTEGER NOT NULL
            )""")
            if db.execute("PRAGMA user_version").fetchone()[0] == 0:
                # Migrate existing sessions once, including sessions created
                # before filenames were recorded. Never infer private filenames.
                for directory in root.iterdir():
                    if not SESSION_ID_RE.fullmatch(directory.name) or not directory.is_dir():
                        continue
                    try:
                        data = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
                        if data.get("session_id") == directory.name and data.get("sentences"):
                            _insert(db, summary(data, directory))
                    except (OSError, ValueError, TypeError, AttributeError):
                        logger.warning("Skipping incomplete session %s", directory.name)
                db.execute("PRAGMA user_version = 1")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()


def register(root, data):
    item = summary(data, root / data["session_id"])
    with catalogue(root) as db:
        _insert(db, item)
    return item


def list_documents(root):
    with catalogue(root) as db:
        # Retry cleanup if an interrupted delete removed the catalogue entry
        # but could not finish releasing disk space.
        for directory in (root / ".library").glob("deleted-*"):
            if directory.is_dir() and re.fullmatch(r"deleted-[0-9a-f]{32}", directory.name):
                try:
                    shutil.rmtree(directory)
                except OSError:
                    logger.warning("Could not finish deleting %s", directory.name)
        rows = db.execute("SELECT * FROM documents ORDER BY created_at DESC, session_id DESC").fetchall()
    # Only summaries: listing never loads sentence text or audio into memory.
    return [dict(row) for row in rows]


def rename(root, session_id, name):
    with catalogue(root) as db:
        changed = db.execute("UPDATE documents SET name=? WHERE session_id=?", (name, session_id))
        if not changed.rowcount:
            return None
        return dict(db.execute("SELECT * FROM documents WHERE session_id=?", (session_id,)).fetchone())


def delete(root, session_id):
    if not SESSION_ID_RE.fullmatch(session_id):
        return False
    with catalogue(root) as db:
        directory = root / session_id
        if not db.execute("SELECT 1 FROM documents WHERE session_id=?", (session_id,)).fetchone():
            return False
        # Remove from public paths before publishing the catalogue change.
        trash = root / ".library" / ("deleted-" + uuid.uuid4().hex)
        if directory.exists():
            directory.replace(trash)
        try:
            db.execute("DELETE FROM documents WHERE session_id=?", (session_id,))
            db.commit()
        except BaseException:
            if trash.exists():
                trash.replace(directory)
            raise
        if trash.exists():
            shutil.rmtree(trash)
    return True
