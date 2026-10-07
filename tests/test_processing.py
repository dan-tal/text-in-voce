"""Exercise real HTTP routes, extraction and WAV output without downloading TTS."""
import asyncio
import io
import sys
import threading
import types
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import docx
import httpx
import pytest

# Piper 1.2 is a Linux deployment dependency. The fake produces valid WAV files
# and blocks on demand so that concurrency is verified without timing guesses.
sys.modules.setdefault("piper", types.SimpleNamespace(PiperVoice=object))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import main


class FakeVoice:
    def synthesize(self, text, wav_file):
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(8000)
        wav_file.writeframes(b"\0\0" * 800)


@pytest.fixture
def backend(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "AUDIO_DIR", tmp_path)
    monkeypatch.setattr(main, "PROCESSING_WORKERS", 2)
    monkeypatch.setattr(main, "get_voice", lambda: FakeVoice())
    monkeypatch.setattr(main, "_build_mp3", lambda *args: None)
    return tmp_path


async def wait_until(predicate):
    for _ in range(500):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Worker did not reach the expected state")


def test_parallel_uploads_keep_http_responsive_and_sessions_isolated(backend, monkeypatch):
    release = threading.Event()
    lock = threading.Lock()
    started = []
    process_document = main.process_document

    def blocked(filename, content):
        with lock:
            started.append(filename)
        assert release.wait(5)
        return process_document(filename, content)

    monkeypatch.setattr(main, "process_document", blocked)

    async def scenario():
        async with main.app.router.lifespan_context(main.app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(main.app), base_url="http://test") as client:
                requests = [asyncio.create_task(client.post("/api/upload", files={"file": (f"{i}.txt", f"Document {i}. Salut!")})) for i in range(3)]
                try:
                    await wait_until(lambda: len(started) == 2 and main.app.state.pending_documents == 3)
                    # Both workers are still blocked. HTTP must be served now.
                    response = await asyncio.wait_for(client.get("/"), timeout=1)
                    assert response.status_code == 200
                    assert len(started) == 2  # third document remains queued
                finally:
                    release.set()
                responses = await asyncio.gather(*requests)
                assert all(response.status_code == 200 for response in responses)
                sessions = [response.json() for response in responses]
                assert len({session["session_id"] for session in sessions}) == 3
                for i, session in enumerate(sessions):
                    assert session["sentences"][0]["text"] == f"Document {i}."
                    assert session["sentences"][0]["duration"] == 0.1
                    persisted = await client.get(f'/api/session/{session["session_id"]}')
                    assert persisted.json() == session
                    assert (backend / session["session_id"] / "0.wav").exists()
                assert main.app.state.pending_documents == 0

    asyncio.run(scenario())


def test_overload_and_cancelled_request_keep_capacity_reserved(backend, monkeypatch):
    release = threading.Event()
    started = threading.Event()
    monkeypatch.setattr(main, "MAX_PENDING_DOCUMENTS", 1)
    original = main.process_document

    def blocked(*args):
        started.set()
        assert release.wait(5)
        return original(*args)

    monkeypatch.setattr(main, "process_document", blocked)

    async def scenario():
        async with main.app.router.lifespan_context(main.app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(main.app), base_url="http://test") as client:
                request = asyncio.create_task(client.post("/api/upload", files={"file": ("one.txt", "Salut.")}))
                try:
                    await wait_until(started.is_set)
                    request.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await request
                    response = await client.post("/api/upload", files={"file": ("two.txt", "Salut.")})
                    assert response.status_code == 429
                    assert response.headers["retry-after"] == "5"
                    assert main.app.state.pending_documents == 1
                finally:
                    release.set()
                await wait_until(lambda: main.app.state.pending_documents == 0)
                response = await client.post("/api/upload", files={"file": ("three.txt", "Salut.")})
                assert response.status_code == 200

    asyncio.run(scenario())


@pytest.mark.parametrize("filename,content,status", [
    ("file.exe", b"hello", 400), ("empty.txt", b" \n ", 400),
    ("bad.docx", b"corrupt", 400), ("bad.pdf", b"corrupt", 400),
    ("large.txt", b"x" * 101, 413),
])
def test_invalid_uploads_release_capacity(backend, monkeypatch, filename, content, status):
    monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 100)

    async def scenario():
        async with main.app.router.lifespan_context(main.app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(main.app), base_url="http://test") as client:
                response = await client.post("/api/upload", files={"file": (filename, content)})
                assert response.status_code == status
                assert main.app.state.pending_documents == 0
                assert not list(backend.iterdir())

    asyncio.run(scenario())


def test_synthesis_failure_removes_partial_audio(backend, monkeypatch):
    class BrokenVoice(FakeVoice):
        def synthesize(self, text, wav_file):
            super().synthesize(text, wav_file)
            raise RuntimeError("private engine details")

    monkeypatch.setattr(main, "get_voice", lambda: BrokenVoice())
    with pytest.raises(main.HTTPException) as error:
        main.process_document("file.txt", b"Salut.")
    assert error.value.status_code == 500
    assert "private engine details" not in error.value.detail
    assert not list(backend.iterdir())


def test_worker_voices_are_reused_but_not_shared(monkeypatch):
    monkeypatch.setattr(main, "_voices", threading.local())
    monkeypatch.setattr(main, "_download_if_missing", lambda: None)
    monkeypatch.setattr(main, "PiperVoice", types.SimpleNamespace(load=lambda *args, **kwargs: object()))
    barrier = threading.Barrier(2)

    def get_twice():
        first = main.get_voice()
        barrier.wait(timeout=5)
        assert main.get_voice() is first
        return first

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(get_twice)
        second = pool.submit(get_twice)
        assert first.result() is not second.result()


def test_failed_model_download_is_not_published(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "MODEL_PATH", tmp_path / "model.onnx")
    monkeypatch.setattr(main, "CONFIG_PATH", tmp_path / "model.json")

    def interrupted(url, destination):
        destination.write_bytes(b"partial download")
        raise OSError("network failure")

    monkeypatch.setattr(main.urllib.request, "urlretrieve", interrupted)
    with pytest.raises(OSError):
        main._download_if_missing()
    assert not list(tmp_path.iterdir())


def test_bom_txt_and_docx_structure(backend):
    assert main.extract_blocks("file.txt", b"\xef\xbb\xbfSalut.")[0]["runs"][0]["t"] == "Salut."
    document = docx.Document()
    document.add_heading("Titlu", level=1)
    document.add_table(rows=1, cols=1).cell(0, 0).text = "Tabel."
    document.add_paragraph("Salut.")
    content = io.BytesIO()
    document.save(content)
    result = main.process_document("file.docx", content.getvalue())
    assert result["blocks"][0] == {"type": "heading", "level": 1, "sentence_indices": [0]}
    assert result["sentences"][1]["text"] == "Tabel."
    assert result["sentences"][2]["text"] == "Salut."


def test_mp3_timeout_preserves_sentence_audio_and_removes_partial_export(backend, monkeypatch):
    result = main.process_document("file.txt", b"Salut.")
    session_dir = backend / result["session_id"]
    # Undo this fixture's MP3 stub to exercise the export failure path.
    monkeypatch.undo()

    def timeout(*args, **kwargs):
        (session_dir / "full.mp3").write_bytes(b"partial")
        raise main.subprocess.TimeoutExpired("ffmpeg", kwargs["timeout"])

    monkeypatch.setattr(main.subprocess, "run", timeout)
    assert main._build_mp3(session_dir, 1) is None
    assert (session_dir / "0.wav").exists()
    assert not (session_dir / "full.wav").exists()
    assert not (session_dir / "full.mp3").exists()


def make_pdf(page_texts):
    """Small valid fixture, including deliberately empty source pages."""
    count = len(page_texts)
    kids = " ".join(f"{4 + i * 2} 0 R" for i in range(count))
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>",
               f"<< /Type /Pages /Kids [{kids}] /Count {count} >>".encode(),
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"]
    for i, text in enumerate(page_texts):
        stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode() if text else b""
        objects.extend([
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {5 + i * 2} 0 R >>".encode(),
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        ])
    output = b"%PDF-1.4\n"
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(output)
    output += f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode()
    output += b"".join(f"{offset:010} 00000 n \n".encode() for offset in offsets[1:])
    return output + f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()


def test_pdf_keeps_original_numbering_blank_pages_and_styles(backend):
    content = make_pdf(["First page.", "", "Third page.", ""])
    result = main.process_document("document.pdf", content)
    assert result["page_count"] == 4
    assert [sentence["page"] for sentence in result["sentences"]] == [1, 3]
    assert [block["page"] for block in result["blocks"]] == [1, 3]
    assert result["sentences"][0]["runs"][0]["b"] is True
    assert result["original_url"].endswith("/original.pdf")
    assert (backend / result["session_id"] / "original.pdf").read_bytes() == content


def test_docx_styles_survive_concurrent_processing_refactor(backend):
    from docx.enum.text import WD_COLOR_INDEX
    document = docx.Document()
    paragraph = document.add_paragraph()
    run = paragraph.add_run("Text marcat.")
    run.bold = True
    run.italic = True
    run.underline = True
    run.font.highlight_color = WD_COLOR_INDEX.YELLOW
    content = io.BytesIO()
    document.save(content)
    result = main.process_document("styled.docx", content.getvalue())
    assert result["sentences"][0]["runs"] == [{"t": "Text marcat.", "hl": "#ffff00", "b": True, "i": True, "u": True}]
