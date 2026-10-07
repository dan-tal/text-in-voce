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

1. Încarci unul sau mai multe fișiere (.docx / .pdf / .txt) din pagina principală.
   Interfața trimite maximum două documente simultan și păstrează restul în
   așteptare. Poți adăuga altele fără să oprești redarea documentului curent.
   Fiecare document are stare proprie, buton de deschidere și reîncercare la eroare.
2. Backend-ul (FastAPI) extrage textul:
   - `.docx` → `python-docx`, păstrând ordinea paragrafelor și tabelelor
   - `.pdf` → `pdfplumber`
   - `.txt` → citire directă
3. Textul e împărțit în propoziții (regex pe `.`, `!`, `?`).
4. Extragerea și sinteza rulează într-un grup separat de fire de execuție, astfel
   încât serverul poate servi interfața, sesiunile și audio în timpul procesării.
   Fiecare fir reutilizează propria instanță Piper. Fiecare propoziție e sintetizată separat cu motorul TTS `piper-tts`
   (modelul `ro_RO-mihai-medium`), generând câte un fișier `.wav`. Toate
   fișierele sunt apoi concatenate și convertite cu `ffmpeg` într-un singur
   `full.mp3`, descărcabil din interfață.
5. Frontend-ul primește lista de propoziții + URL-uri audio + durata fiecăreia
   și le redă în ordine, evidențiind propoziția curentă și, prin interpolare
   liniară a `currentTime / duration` peste numărul de cuvinte, cuvântul
   curent aproximativ (motorul TTS nu expune timestamp-uri per-cuvânt, deci e
   o aproximare, nu un timing exact din model).
6. Formatarea din document (evidențiere/marker, bold, italic, subliniat) se
   păstrează în textul citit. Pentru `.pdf`, originalul apare alături și
   își schimbă pagina automat pe măsură ce se citește.
7. Poți apăsa oricând pe o propoziție/cuvânt din text ca să sari acolo cu
   redarea, iar viteza e reglabilă între 0.5x și 3x.
   Butoanele **Prev / Next** și câmpul **Pagina** permit navigarea în document.
   Introdu numărul și apasă **Mergi** sau Enter. La PDF, numărul corespunde
   paginii originale, inclusiv paginilor fără text; originalul și textul sunt
   sincronizate. La TXT, DOCX și text lipit, paginile de lectură au aproximativ
   3.000 de caractere, fără a despărți propozițiile. Acestea nu reprezintă
   paginile de imprimare Word. Redarea continuă trece automat între pagini;
   navigarea manuală oprește redarea, iar Play începe de pe pagina aleasă.
8. Fiecare document procesat primește un link partajabil (`?s=<id>`) —
   metadatele sesiunii sunt salvate pe disc, deci link-ul poate fi redeschis
   direct, fără reîncărcare, cât timp containerul rulează.
   Linkul include și pagina selectată (`?s=<id>&p=<pagina>`).

## Biblioteca comună

Documentele procesate apar automat în **Biblioteca documentelor**, comună pentru
toți utilizatorii. Lista se reîncarcă la deschiderea paginii și rămâne disponibilă
după repornirea containerului, în același volum Docker ca fișierele audio.
Biblioteca este inițial pliată: apasă titlul pentru a o deschide sau închide.
Antetul arată numărul documentelor și indicatorul +/−. Apăsarea **Deschide**
pliază biblioteca și deschide documentul în player. Titlul poate fi
activat și cu Enter sau Space de la tastatură.

Încărcările noi apar în lista de sus, cu maximum trei fișiere recente afișate;
documentele mai vechi nu sunt șterse când ies din această listă. Toate rezultatele
procesate apar și în biblioteca persistentă. Butonul **Șterge** din oricare dintre
cele două liste elimină documentul din ambele și șterge audio, după confirmare.
Coada continuă să proceseze toate fișierele chiar dacă sus sunt vizibile doar trei.
Poți căuta după nume, deschide un rezultat, redenumi sau șterge un document.
Butonul **Actualizează** preia și modificările făcute de alți utilizatori.
Lista încarcă doar rezumatele documentelor; textul integral se încarcă la deschidere.

**Șterge** cere confirmare și elimină documentul, audio WAV/MP3 și originalul PDF
pentru toți utilizatorii. Linkul partajat nu va mai funcționa. Documentele din
coada browserului și cele cu erori pot fi eliminate din listă; un document aflat
în procesare poate fi șters după terminare. Erorile și coada neîncepută nu sunt
păstrate după reîncărcarea paginii.

Sesiunile create înainte de bibliotecă sunt importate automat la prima utilizare.
Numele lor originale nu erau salvate, deci apar ca `Document <id>` și pot fi
redenumite. Catalogul SQLite este salvat în `/app/static/audio/.library`,
protejat de acces prin ruta de fișiere statice. Biblioteca nu folosește conturi:
orice vizitator al aplicației poate vedea, redenumi și șterge documentele comune.

API: `GET /api/library`, `PATCH /api/library/{id}` cu `{"name":"Nume nou"}` și
`DELETE /api/library/{id}`. Metadatele și audio se citesc în continuare prin
`/api/session/{id}` și `/audio/{id}/...`.

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

## Deploy pe server

`./deploy.sh [versiune]` construiește și împinge `dan4kl/text-in-voce:latest`
pe Docker Hub (versiunea apare în footer, ca reper pentru build-ul rulat).

Pe server, `docker-compose.prod.yml` trage imaginea (nu o construiește) și o
expune prin Traefik la `textinvoce.casatd.org` (rețeaua externă `proxy`
trebuie să existe deja pe server):

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

## Limite și configurare

Backend-ul acceptă implicit două procesări simultane, maximum opt documente
în total (citire + procesare + așteptare) și fișiere de maximum 20 MB.
Când coada este plină, `/api/upload` răspunde cu HTTP 429 și `Retry-After: 5`;
un fișier prea mare primește HTTP 413. Rezultatele incomplete sunt șterse dacă
sinteza eșuează. Dacă exportul MP3 eșuează sau depășește cinci minute, WAV-urile
rămân disponibile pentru redare.

Aceste valori se pot modifica prin variabile de mediu în serviciul Docker:

```yaml
environment:
  PROCESSING_WORKERS: "2"
  MAX_PENDING_DOCUMENTS: "8"
  MAX_UPLOAD_MB: "20"
```

Limitele sunt per proces Uvicorn (configurația Docker folosește un singur proces).
Creșterea numărului de procesări crește și memoria folosită de instanțele modelului.
Propozițiile aceluiași document sunt sintetizate în ordine. Cererea HTTP rămâne
deschisă până la terminare: pentru documente mari, configurează timeout-ul
proxy-ului corespunzător. Documentele finalizate se păstrează în biblioteca
comună până când sunt șterse; fiecare rezultat poate fi redeschis prin linkul său.

## Verificare

Testele backend verifică procesarea paralelă, răspunsul HTTP în timpul sintezei,
izolarea sesiunilor, coada plină, deconectarea clientului, fișierele invalide și
curățarea rezultatelor parțiale. Folosesc un motor TTS simulat care produce WAV
valid, fără a descărca modelul:

```bash
pip install -r backend/requirements-test.txt
python -m pytest tests -q
```

Testele de interfață verifică încărcarea multiplă, limita de două cereri,
selectarea rezultatelor, reîncercarea erorilor, încărcarea linkurilor partajate,
paginarea, paginile PDF goale, păstrarea formatării și coada pentru textul lipit:

```bash
npm install
npx playwright install chromium
npm run test:frontend
```

## Note

- Rulează 100% local, fără cont cloud sau API key.
- Fișierele audio generate sunt salvate în volumul Docker `audio_data`
  (`/app/static/audio` în container) — poți șterge volumul dacă vrei să
  cureți spațiul: `docker compose down -v`.
- Testat cu fișiere text scurte/medii; fișiere foarte mari vor genera multe
  propoziții și pot dura mai mult la sinteza audio (secvențială, propoziție
  cu propoziție).
