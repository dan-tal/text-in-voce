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
   Serverul confirmă încărcarea prin HTTP 202 și generează audio în fundal.
   Interfața verifică progresul prin cereri scurte, fără a aștepta sinteza
   întregului document într-o cerere care poate expira la proxy (524).
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
   păstrează în textul citit, afișat într-o singură coloană.
7. Poți apăsa oricând pe o propoziție/cuvânt din text ca să sari acolo cu
   redarea. Bara fixă din josul ecranului are trei butoane: **▶/⏸** (redare și
   pauză), viteza (apăsări succesive: 0.75x, 1x, 1.25x, 1.5x, 2x, 3x) și **🎙 Remarcă**.
   Sus, **‹ ›** și câmpul **Pagina** (Enter) navighează în document. La PDF,
   numărul corespunde paginii originale, inclusiv paginilor fără text. La TXT,
   DOCX și text lipit, paginile de lectură au aproximativ 3.000 de caractere,
   fără a despărți propozițiile. Redarea continuă trece automat între pagini;
   navigarea manuală oprește redarea, iar Play începe de pe pagina aleasă.
8. Fiecare document procesat primește un link partajabil (`?s=<id>`) —
   metadatele sesiunii sunt salvate pe disc, deci link-ul poate fi redeschis
   direct, fără reîncărcare, cât timp containerul rulează.
   Linkul include și pagina selectată (`?s=<id>&p=<pagina>`). Butoanele
   **Partajează** și **MP3** apar doar pentru documentele generate în acest
   browser; cine deschide un link primit poate citi, asculta și lăsa remarci,
   dar nu le vede (e o alegere de interfață, nu o protecție: fișierele rămân
   accesibile oricui are linkul).

## Documente recente și ștergere

Lista de sus afișează maximum trei fișiere recente. Toate fișierele selectate
continuă să fie procesate, chiar dacă nu mai sunt vizibile în această listă.
Documentele mai vechi nu sunt șterse când ies din listă și pot fi redeschise
prin linkul partajat. La reîncărcarea paginii se deschide doar documentul din
link, fără a afișa o bibliotecă sau previzualizarea PDF originală.

**Șterge** cere confirmare și elimină documentul, audio WAV/MP3 și originalul PDF.
Linkul partajat nu va mai funcționa. Documentele din coada browserului și cele
cu erori pot fi eliminate; un document aflat în procesare poate fi șters după
terminare. Coada neîncepută și fișierele locale pentru reîncercare nu sunt
păstrate după reload. Identificatorii procesărilor trimise serverului sunt
reținuți în browser: urmărirea lor se reia după reload, fără sinteză duplicată.

Catalogul SQLite existent rămâne în volumul audio, protejat de acces prin ruta
de fișiere statice. Eliminarea bibliotecii din interfață nu șterge documentele
salvate. API-urile existente rămân compatibile: `GET /api/library`,
`PATCH /api/library/{id}` și `DELETE /api/library/{id}`. Proiectul nu folosește
conturi; oricine are linkul unui document îl poate deschide și șterge.

## Remarci vocale

Când oprești citirea la un paragraf, apeși **🎙 Remarcă vocală** (bara fixă din
josul ecranului, gândită pentru telefon) și spui remarca. Ținta este paragraful
la care s-a oprit redarea, afișat și în bară; poți folosi și butonul **🎙 Remarcă**
de sub orice paragraf. Redarea se oprește automat la început, ca microfonul să nu
prindă vocea sintetică. Înregistrarea are cronometru, durează maximum 3 minute,
iar după oprire o poți asculta și salva sau reface. Numele (opțional) se reține
în browser.

Remarcile sunt comune: apar sub paragraf ca butoane `▶ 0:12`
pentru toți cei care deschid documentul, se pot șterge individual (✕) și dispar odată cu documentul.
Microfonul cere HTTPS (sau localhost); fără el, pe telefon se deschide
aplicația de înregistrare audio a dispozitivului.

API: `GET /api/session/{id}/remarks`, `POST /api/session/{id}/remarks`
(multipart: `audio`, `sentence_index`, opțional `duration`, `author`) și
`DELETE /api/session/{id}/remarks/{remark_id}`. Limită: `MAX_REMARK_MB` (15).

## Pe telefon

Interfața e gândită întâi pentru telefon (testată la 320, 360, 390 px și în
landscape), iar pe calculator rămâne la fel.

- **Instalare**: în Chrome (Android) sau Safari (iPhone → Partajează → *Adaugă pe
  ecranul principal*) aplicația se deschide ca o aplicație obișnuită, fără bara
  browserului (`manifest.webmanifest` + iconițe în `frontend/icons/`).
- **Ecran blocat și căști**: titlul documentului, pagina și butoanele
  play/pauză/următoarea/anterioara (propoziție) apar pe ecranul blocat și în
  notificări (Media Session API). „Anterioara" repornește mai întâi propoziția
  începută, ca într-un player muzical.
- **Fără pauze între propoziții**: propoziția următoare se descarcă în timp ce o
  ascultați (nu se preîncarcă dacă browserul are *Economizor de date* activ). Audio
  generat primește `Cache-Control` de 24 h, deci reascultarea nu consumă date.
- **Generare fără întreruperi**: cât timp se generează audio, ecranul rămâne
  aprins (Screen Wake Lock) pentru a vedea progresul. Serverul continuă dacă
  telefonul adoarme; verificările se reiau automat când conexiunea revine.
- **Butonul Înapoi** închide foaia de remarcă vocală în loc să părăsească pagina
  (și să piardă înregistrarea).
- **Partajează** deschide meniul de partajare al telefonului (WhatsApp, SMS…);
  pe calculator copiază linkul.
- **Atingeri**: toate butoanele au cel puțin 44 px; fără stări `:hover` „lipite"
  după atingere; fără întârziere sau zoom la dublu-tap (ciupitul pentru zoom
  rămâne); iOS nu mai transformă numerele din text în linkuri de telefon;
  adresele web lungi se rup în loc să lățească pagina. Sub text, butoanele
  *Înapoi* / *Pagina următoare* sunt la îndemâna degetului mare.
- **Zone sigure**: marginile respectă notch-ul și bara de acasă
  (`viewport-fit=cover`), iar tastatura Android nu mai acoperă bara de jos.
- La deschiderea unui document, pagina derulează direct la text.

**Important pentru iPhone:** Safari nu redă audio de la un server care nu
răspunde la cereri `Range` cu `206 Partial Content`. Dependențele actuale
(`fastapi==0.142.4`, `starlette==1.7.0`) includ acest suport; versiunea veche
`fastapi==0.115.0` nu îl oferea prin Starlette-ul instalat atunci.
Un test (`test_audio_supports_range_requests…`) pică dacă versiunea scade.

`index.html`, `script.js` și `style.css` se servesc cu `Cache-Control: no-cache`
(validare prin ETag → răspuns 304), ca un telefon care ține fila deschisă să nu
combine o pagină nouă cu un script vechi după deploy.

## Structură

```
backend/
  main.py           # FastAPI: /api/upload, extragere text, TTS, servire audio + frontend
  library.py        # catalogul documentelor (SQLite), ștergere
  remarks.py        # remarci audio atașate paragrafelor
  requirements.txt
  Dockerfile
frontend/
  index.html
  style.css
  script.js
  version.js
  manifest.webmanifest   # aplicație instalabilă pe telefon
  icons/                 # icon.svg, icon-192.png, icon-512.png, apple-touch-icon.png
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
Când coada este plină, `/api/jobs` și `/api/upload` răspund cu HTTP 429 și `Retry-After: 5`;
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
Propozițiile aceluiași document sunt sintetizate în ordine. `POST /api/jobs`
primește un fișier și întoarce rapid HTTP 202 cu `job_id` și antet `Location`.
`GET /api/jobs/{job_id}` întoarce `queued`, `processing`, `ready` sau `failed`,
etapa curentă și numărul de propoziții sintetizate. La `ready`, `session_id`
permite încărcarea documentului prin `GET /api/session/{session_id}`.
Parametrul multipart opțional `request_id` (32 de caractere hexazecimale mici)
permite reîncercarea aceleiași încărcări fără a crea o a doua procesare.
Interfața reia automat verificările după o întrerupere temporară de rețea.
API-ul vechi `POST /api/upload` rămâne sincron pentru compatibilitate;
clienții externi trebuie să treacă la `/api/jobs` pentru a evita timeout-urile.

Stările sunt salvate în directorul privat `.jobs` din volumul audio. La pornire,
înregistrările finalizate mai vechi de șapte zile se curăță, iar procesările
întrerupte de repornirea serverului raportează o eroare clară și cer reîncărcare.
Fișierul de intrare nu este păstrat pentru reluarea sintezei după restart.
Vocea se încarcă la prima procesare în fiecare fir; o eroare de descărcare nu
împiedică pornirea HTTP sau accesul la documentele deja generate.
Documentele finalizate rămân pe disc până când sunt
șterse; fiecare rezultat poate fi redeschis prin linkul său.

## Verificare

Testele backend verifică procesarea paralelă, răspunsul HTTP în timpul sintezei,
izolarea sesiunilor, coada plină, deconectarea clientului, fișierele invalide și
curățarea rezultatelor parțiale. Folosesc un motor TTS simulat care produce WAV
valid, fără a descărca modelul:

```bash
pip install -r backend/requirements-test.txt
python -m pytest tests -q
```

Testele backend verifică și suportul `Range`/`206`, headerele de cache și
manifestul aplicației, răspunsul 202 înaintea sintezei, deduplicarea încărcărilor,
persistența progresului, erorile procesărilor și protecția remarcilor la ștergere.

Testele de interfață verifică faptul că biblioteca și previzualizarea PDF nu mai
sunt afișate, încărcarea simultană cu maximum trei documente recente, paginarea,
ștergerea documentului activ, remarcile vocale, bara de jos, butoanele ascunse
pentru linkurile partajate și lizibilitatea textului (contrast verificat în toate
stările, inclusiv hover, foaia de înregistrare și dialogul de ștergere).
Pentru telefon (browser emulat cu atingere): fără scroll orizontal la 320–740 px,
chiar și cu adrese web foarte lungi, ținte de minimum 44 px, controalele de pe
ecranul blocat, preîncărcarea propoziției următoare, partajarea, butonul Înapoi
din foaia de remarcă, ecranul ținut aprins la generare și footer-ul nemascat de
bara de jos:

```bash
npm install
npx playwright install chromium
npm run test:frontend
```

Testele verifică și progresul în fundal, reluarea după reload, reîncercarea
verificărilor după 524 și eliberarea microfonului la erori sau schimbarea
documentului. GitHub Actions rulează ambele suite pe push și pull request.

## Note

- Rulează 100% local, fără cont cloud sau API key.
- Fișierele audio generate sunt salvate în volumul Docker `audio_data`
  (`/app/static/audio` în container) — poți șterge volumul dacă vrei să
  cureți spațiul: `docker compose down -v`.
- Testat cu fișiere text scurte/medii; fișiere foarte mari vor genera multe
  propoziții și pot dura mai mult la sinteza audio (secvențială, propoziție
  cu propoziție).
