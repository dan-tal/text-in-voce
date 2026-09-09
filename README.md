# Text în voce

Aplicație web mică, dockerizată, care citește cu voce tare (română) fișiere
.docx, .pdf sau .txt, cu evidențierea textului pe măsură ce se citește.

## Cum pornești

```bash
docker compose up --build
```

Apoi deschide http://localhost:8000 în browser.

Prima construire (`--build`) descarcă vocea română `ro_RO-mihai-medium` de pe
Hugging Face (~60 MB) — durează câteva zeci de secunde în plus, în funcție de
conexiune. Dacă descărcarea eșuează la build (de ex. fără rețea în etapa de
build), backend-ul reîncearcă automat la primul request către `/api/upload`.

## Cum funcționează

1. Încarci un fișier (.docx / .pdf / .txt) din pagina principală.
2. Backend-ul (FastAPI) extrage textul:
   - `.docx` → `python-docx`
   - `.pdf` → `pdfplumber`
   - `.txt` → citire directă
3. Textul e împărțit în propoziții (regex pe `.`, `!`, `?`).
4. Fiecare propoziție e sintetizată separat cu motorul TTS `piper-tts`
   (modelul `ro_RO-mihai-medium`), generând câte un fișier `.wav`. Toate
   fișierele sunt apoi concatenate și convertite cu `ffmpeg` într-un singur
   `full.mp3`, descărcabil din interfață.
5. Frontend-ul primește lista de propoziții + URL-uri audio + durata fiecăreia
   și le redă în ordine, evidențiind propoziția curentă și, prin interpolare
   liniară a `currentTime / duration` peste numărul de cuvinte, cuvântul
   curent aproximativ (motorul TTS nu expune timestamp-uri per-cuvânt, deci e
   o aproximare, nu un timing exact din model).
6. Poți apăsa oricând pe o propoziție/cuvânt din text ca să sari acolo cu
   redarea, iar viteza e reglabilă între 0.5x și 3x.
7. Fiecare document procesat primește un link partajabil (`?s=<id>`) —
   metadatele sesiunii sunt salvate pe disc, deci link-ul poate fi redeschis
   direct, fără reîncărcare, cât timp containerul rulează.

## Structură

```
backend/
  main.py           # FastAPI: /api/upload, extragere text, TTS, servire audio + frontend
  requirements.txt
  Dockerfile
frontend/
  index.html
  style.css
  script.js
docker-compose.yml
```

Backend-ul servește și frontend-ul (fișiere statice), deci totul rulează
într-un singur container/serviciu — un singur `docker compose up` pornește
tot ce trebuie.

## Note

- Rulează 100% local, fără cont cloud sau API key.
- Fișierele audio generate sunt salvate în volumul Docker `audio_data`
  (`/app/static/audio` în container) — poți șterge volumul dacă vrei să
  cureți spațiul: `docker compose down -v`.
- Testat cu fișiere text scurte/medii; fișiere foarte mari vor genera multe
  propoziții și pot dura mai mult la sinteza audio (secvențială, propoziție
  cu propoziție).
