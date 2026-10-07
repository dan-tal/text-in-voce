const uploadForm = document.getElementById("upload-form");
const fileInput = document.getElementById("file-input");
const uploadBtn = document.getElementById("upload-btn");
const statusEl = document.getElementById("status");
const playerSection = document.getElementById("player-section");
const textContainer = document.getElementById("text-container");
const playBtn = document.getElementById("play-btn");
const pauseBtn = document.getElementById("pause-btn");
const stopBtn = document.getElementById("stop-btn");
const speedSlider = document.getElementById("speed-slider");
const speedValue = document.getElementById("speed-value");
const downloadLink = document.getElementById("download-link");
const pasteBtn = document.getElementById("paste-btn");
const pasteBox = document.getElementById("paste-box");
const pasteText = document.getElementById("paste-text");
const pasteSubmit = document.getElementById("paste-submit");
const shareBtn = document.getElementById("share-btn");
const originalPane = document.getElementById("original-pane");
const originalFrame = document.getElementById("original-frame");
const readerLayout = document.getElementById("reader-layout");
const prevPageBtn = document.getElementById("prev-page");
const nextPageBtn = document.getElementById("next-page");
const pageForm = document.getElementById("page-form");
const pageInput = document.getElementById("page-input");
const pageCountEl = document.getElementById("page-count");
const pageKindEl = document.getElementById("page-kind");
const READER_PAGE_CHARACTERS = 3000;
let readerPages = [];
let currentPage = 0;
const sentencePages = new Map();
const documentList = document.getElementById("document-list");
const recentDocumentList = document.getElementById("recent-document-list");
const recentDocumentsHint = document.getElementById("recent-documents-hint");
const recentDocuments = [];
const MAX_RECENT_DOCUMENTS = 3;
const librarySection = document.getElementById("library-section");
const libraryCount = document.getElementById("library-count");
const librarySearch = document.getElementById("library-search");
const libraryStatus = document.getElementById("library-status");
const libraryEmpty = document.getElementById("library-empty");
const libraryRefresh = document.getElementById("library-refresh");
const documentDialog = document.getElementById("document-dialog");
const dialogForm = document.getElementById("document-dialog-form");
const dialogTitle = document.getElementById("document-dialog-title");
const dialogDescription = document.getElementById("document-dialog-description");
const nameInput = document.getElementById("document-name-input");
const nameLabel = document.getElementById("document-name-label");
const dialogError = document.getElementById("document-dialog-error");
const dialogSubmit = document.getElementById("document-dialog-submit");
const dialogCancel = document.getElementById("document-dialog-cancel");
let dialogJob = null;
let dialogAction = null;
let dialogBusy = false;
let libraryLoadVersion = 0;
let openingDocument = null;
const documents = [];
const uploadQueue = [];
const MAX_PARALLEL_UPLOADS = 2;
let activeUploads = 0;
let selectionVersion = 0;
const sentenceElements = new Map();
let activeSentenceEl = null;
let activeWordEl = null;

let sentences = [];
let currentIndex = -1;
let playbackRate = 1.0;
let currentSessionId = null;
let originalUrl = null;
let shownPage = null;
let playbackRequest = 0;
const audio = new Audio();

const versionEl = document.getElementById("app-version");
if (versionEl && window.APP_VERSION) {
  versionEl.textContent = `v${window.APP_VERSION}`;
}

uploadForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const files = Array.from(fileInput.files);
  if (!files.length) return;
  files.forEach(enqueueFile);
  fileInput.value = "";
  pumpUploads();
});

function enqueueFile(file) {
  librarySection.open = false;
  const job = addDocument(file.name);
  job.isUpload = true;
  job.file = file;
  addRecentDocument(job);
  uploadQueue.push(job);
}

function addRecentDocument(job) {
  const row = document.createElement("li");
  row.className = "recent-document-row";
  const nameEl = document.createElement("strong");
  nameEl.className = "document-name";
  const stateEl = document.createElement("span");
  stateEl.className = "document-status";
  const button = document.createElement("button");
  button.type = "button";
  button.addEventListener("click", () => activateDocument(job));
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "danger-btn";
  deleteButton.textContent = "Elimină";
  deleteButton.addEventListener("click", () => {
    if (job.state === "ready") editDocument(job, "delete");
    else if (job.state !== "processing") removeDocument(job);
  });
  const actions = document.createElement("div");
  actions.className = "document-actions";
  actions.append(button, deleteButton);
  row.append(nameEl, stateEl, actions);
  job.recent = { row, nameEl, stateEl, button, deleteButton };
  recentDocumentList.append(row);
  recentDocuments.push(job);
  while (recentDocuments.length > MAX_RECENT_DOCUMENTS) removeRecentDocument(recentDocuments[0]);
  syncRecentDocument(job);
  recentDocumentsHint.hidden = false;
}

function syncRecentDocument(job) {
  if (!job.recent) return;
  const view = job.recent;
  view.nameEl.textContent = job.name;
  view.stateEl.textContent = job.stateEl.textContent;
  view.button.textContent = job.button.textContent;
  view.button.disabled = job.button.disabled;
  view.deleteButton.disabled = job.state === "processing";
  view.deleteButton.textContent = job.state === "ready" ? "Șterge" : "Elimină";
  view.deleteButton.title = job.state === "processing" ? "Poți șterge documentul după terminarea procesării" :
    "Șterge documentul din ambele liste și elimină fișierele audio";
  view.button.setAttribute("aria-pressed", String(job.sessionId === currentSessionId));
  view.row.classList.toggle("failed", job.state === "failed");
  view.row.classList.toggle("selected", !!job.sessionId && job.sessionId === currentSessionId);
}

function removeRecentDocument(job) {
  job.recent?.row.remove();
  job.recent = null;
  const index = recentDocuments.indexOf(job);
  if (index >= 0) recentDocuments.splice(index, 1);
  recentDocumentsHint.hidden = recentDocuments.length === 0;
}

function activateDocument(job) {
  if (job.button.disabled || job.removed) return;
  if (job.state === "ready") openDocument(job);
  else if (job.state === "failed") {
    job.state = "queued";
    job.row.classList.remove("failed");
    job.stateEl.textContent = "În așteptare";
    job.button.disabled = true;
    syncRecentDocument(job);
    uploadQueue.push(job);
    pumpUploads();
  }
}

function addDocument(name) {
  const row = document.createElement("li");
  row.className = "document-row";
  const nameEl = document.createElement("strong");
  nameEl.className = "document-name";
  nameEl.textContent = name;
  const stateEl = document.createElement("span");
  stateEl.className = "document-status";
  stateEl.textContent = "În așteptare";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Deschide";
  button.disabled = true;
  const renameButton = document.createElement("button");
  renameButton.type = "button";
  renameButton.textContent = "Redenumește";
  renameButton.className = "secondary-btn";
  renameButton.hidden = true;
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.textContent = "Elimină";
  deleteButton.className = "danger-btn";
  const job = { row, name, nameEl, stateEl, button, renameButton, deleteButton,
    state: "queued", data: null, file: null, sessionId: null, removed: false };
  button.addEventListener("click", () => activateDocument(job));
  renameButton.addEventListener("click", () => editDocument(job, "rename"));
  deleteButton.addEventListener("click", () => {
    if (job.state === "ready") editDocument(job, "delete");
    else if (job.state !== "processing") removeDocument(job);
  });
  const actions = document.createElement("div");
  actions.className = "document-actions";
  actions.append(button, renameButton, deleteButton);
  row.append(nameEl, stateEl, actions);
  documentList.appendChild(row);
  documents.push(job);
  filterLibrary();
  return job;
}

function readyDocument(job, item, data = null) {
  job.sessionId = item.session_id;
  job.data = null;
  job.state = "ready";
  job.file = null;
  job.name = item.name || data?.filename || job.name;
  job.nameEl.textContent = job.name;
  job.stateEl.textContent = `Gata: ${item.sentence_count ?? data?.sentences.length ?? 0} propoziții`;
  job.button.textContent = "Deschide";
  job.button.disabled = false;
  job.renameButton.hidden = false;
  job.deleteButton.textContent = "Șterge";
  job.deleteButton.disabled = false;
  job.row.classList.remove("failed");
  job.row.classList.toggle("selected", job.sessionId === currentSessionId);
  job.button.setAttribute("aria-pressed", String(job.sessionId === currentSessionId));
  syncRecentDocument(job);
  filterLibrary();
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const failure = new Error(error.detail || `Eroare server (${response.status})`);
    failure.status = response.status;
    throw failure;
  }
  return response.status === 204 ? null : response.json();
}

async function openDocument(job) {
  librarySection.open = false;
  const version = ++selectionVersion;
  openingDocument = job;
  job.button.disabled = true;
  syncRecentDocument(job);
  try {
    // Fetch each time: another visitor may have deleted a shared document.
    const data = await requestJson(`/api/session/${encodeURIComponent(job.sessionId)}`);
    if (job.removed || version !== selectionVersion) return;
    applySessionData(data);
  } catch (error) {
    libraryStatus.textContent = `Nu s-a putut deschide documentul: ${error.message}`;
    statusEl.textContent = libraryStatus.textContent;
  } finally {
    job.button.disabled = false;
    syncRecentDocument(job);
    if (openingDocument === job) openingDocument = null;
  }
}

function filterLibrary() {
  libraryCount.textContent = `${documents.length} ${documents.length === 1 ? "document" : "documente"}`;
  const query = librarySearch.value.trim().toLocaleLowerCase("ro");
  let visible = 0;
  documents.forEach((job) => {
    job.row.hidden = !job.name.toLocaleLowerCase("ro").includes(query);
    if (!job.row.hidden) visible += 1;
  });
  libraryEmpty.hidden = visible > 0;
  libraryEmpty.textContent = documents.length ? "Nu există documente care corespund căutării." :
    "Biblioteca este goală. Adaugă documente folosind formularul de mai sus.";
}

async function loadLibrary() {
  const version = ++libraryLoadVersion;
  const known = new Set(documents.filter((job) => job.state === "ready").map((job) => job.sessionId));
  libraryRefresh.disabled = true;
  libraryStatus.textContent = "Se încarcă biblioteca...";
  try {
    const result = await requestJson("/api/library");
    if (version !== libraryLoadVersion) return;
    const ids = new Set(result.documents.map((item) => item.session_id));
    for (const job of [...documents]) {
      if (job.state === "ready" && known.has(job.sessionId) && !ids.has(job.sessionId)) removeDocument(job);
    }
    for (const item of result.documents) {
      const job = documents.find((entry) => entry.sessionId === item.session_id) || addDocument(item.name);
      readyDocument(job, item);
    }
    libraryStatus.textContent = `${result.documents.length} documente salvate în biblioteca comună.`;
    updateUploadStatus();
  } catch (error) {
    if (version === libraryLoadVersion) libraryStatus.textContent = `Nu s-a putut încărca biblioteca: ${error.message}`;
  } finally {
    libraryRefresh.disabled = false;
  }
}

function removeDocument(job) {
  removeRecentDocument(job);
  job.removed = true;
  job.file = null;
  const queued = uploadQueue.indexOf(job);
  if (queued >= 0) uploadQueue.splice(queued, 1);
  const index = documents.indexOf(job);
  if (index >= 0) documents.splice(index, 1);
  job.row.remove();
  if (openingDocument === job) { openingDocument = null; selectionVersion += 1; }
  if (job.sessionId && job.sessionId === currentSessionId) {
    selectionVersion += 1;
    stopPlayback();
    currentSessionId = null;
    sentences = [];
    readerPages = [];
    sentenceElements.clear();
    sentencePages.clear();
    textContainer.replaceChildren();
    originalFrame.onload = null;
    originalFrame.removeAttribute("src");
    originalUrl = null;
    playerSection.hidden = true;
    downloadLink.removeAttribute("href");
    const url = new URL(window.location.href);
    url.searchParams.delete("s"); url.searchParams.delete("p");
    window.history.replaceState({}, "", url);
  }
  filterLibrary();
  updateUploadStatus();
}

function editDocument(job, action) {
  dialogJob = job; dialogAction = action;
  const deleting = action === "delete";
  dialogTitle.textContent = deleting ? "Ștergi documentul?" : "Redenumește documentul";
  dialogDescription.textContent = deleting ?
    `„${job.name}” și fișierele audio vor fi șterse definitiv pentru toți utilizatorii. Linkul partajat nu va mai funcționa.` :
    "Noul nume va apărea în biblioteca comună.";
  nameInput.hidden = nameLabel.hidden = deleting;
  nameInput.required = !deleting;
  nameInput.value = job.name;
  dialogError.textContent = "";
  dialogSubmit.textContent = deleting ? "Șterge definitiv" : "Salvează";
  dialogSubmit.classList.toggle("danger-btn", deleting);
  documentDialog.showModal();
  if (!deleting) { nameInput.focus(); nameInput.select(); }
}

dialogCancel.addEventListener("click", () => documentDialog.close());
documentDialog.addEventListener("cancel", (event) => { if (dialogBusy) event.preventDefault(); });
dialogForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (dialogBusy || !dialogJob || dialogJob.removed) return;
  const job = dialogJob;
  const deleting = dialogAction === "delete";
  const name = nameInput.value.trim();
  if (!deleting && !name) { dialogError.textContent = "Introdu un nume pentru document."; return; }
  dialogBusy = true;
  dialogSubmit.disabled = dialogCancel.disabled = true;
  libraryLoadVersion += 1;
  if (deleting && currentSessionId === job.sessionId) stopPlayback();
  try {
    const item = await requestJson(`/api/library/${encodeURIComponent(job.sessionId)}`, deleting ?
      { method: "DELETE" } : { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (deleting) removeDocument(job);
    else readyDocument(job, item, job.data);
    documentDialog.close();
    libraryStatus.textContent = deleting ? "Documentul și fișierele audio au fost șterse." : "Numele documentului a fost salvat.";
  } catch (error) {
    if (deleting && error.status === 404) {
      removeDocument(job);
      documentDialog.close();
      libraryStatus.textContent = "Documentul a fost deja șters din biblioteca comună.";
    } else dialogError.textContent = error.message;
  } finally {
    dialogBusy = false;
    dialogSubmit.disabled = dialogCancel.disabled = false;
  }
});
librarySearch.addEventListener("input", filterLibrary);
libraryRefresh.addEventListener("click", loadLibrary);

function updateUploadStatus() {
  const uploads = documents.filter((job) => job.isUpload);
  if (!uploads.length && !activeUploads) { statusEl.textContent = ""; return; }
  const ready = uploads.filter((job) => job.state === "ready").length;
  const failed = uploads.filter((job) => job.state === "failed").length;
  statusEl.textContent = `${ready} gata · ${activeUploads} în curs · ${uploadQueue.length} în așteptare` +
    (failed ? ` · ${failed} cu erori` : "");
}

function pumpUploads() {
  while (activeUploads < MAX_PARALLEL_UPLOADS && uploadQueue.length) {
    const job = uploadQueue.shift();
    activeUploads += 1;
    job.state = "processing";
    job.deleteButton.disabled = true;
    job.stateEl.textContent = "Se trimite și se generează audio...";
    syncRecentDocument(job);
    processUpload(job);
  }
  updateUploadStatus();
}

async function processUpload(job) {
  try {
    const formData = new FormData();
    formData.append("file", job.file);
    const res = await fetch("/api/upload", { method: "POST", body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Eroare server (${res.status})`);
    }
    const data = await res.json();
    readyDocument(job, { session_id: data.session_id, name: job.name }, data);
    if (!currentSessionId && !openingDocument) applySessionData(data);
  } catch (err) {
    job.state = "failed";
    job.row.classList.add("failed");
    job.stateEl.textContent = `Eroare: ${err.message}`;
    job.button.textContent = "Reîncearcă";
    job.button.disabled = false;
    job.deleteButton.disabled = false;
    syncRecentDocument(job);
  } finally {
    activeUploads -= 1;
    pumpUploads();
  }
}

function openPasteBox(text) {
  pasteBox.hidden = false;
  if (text !== undefined) pasteText.value = text;
  pasteText.focus();
}

pasteBtn.addEventListener("click", async () => {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch (err) {
    // Clipboard read blocked: show the box so the user can press Ctrl+V in it.
  }
  openPasteBox(text || undefined);
});

document.addEventListener("paste", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "textarea" || tag === "input") return;
  const text = e.clipboardData && e.clipboardData.getData("text");
  if (!text || !text.trim()) return;
  e.preventDefault();
  openPasteBox(text);
});

pasteSubmit.addEventListener("click", () => {
  const text = pasteText.value.trim();
  if (!text) {
    statusEl.textContent = "Textul este gol.";
    return;
  }
  enqueueFile(new File([text], "text-lipit.txt", { type: "text/plain" }));
  pasteText.value = "";
  pumpUploads();
});

function applySessionData(data) {
  selectionVersion += 1;
  stopPlayback();
  currentSessionId = data.session_id;
  documents.forEach((job) => {
    const selected = job.sessionId === currentSessionId;
    job.row.classList.toggle("selected", selected);
    if (job.sessionId) job.button.setAttribute("aria-pressed", String(selected));
    syncRecentDocument(job);
  });
  playerSection.hidden = false;

  originalUrl = data.original_url || null;
  shownPage = null;
  originalPane.hidden = !originalUrl;
  readerLayout.classList.toggle("with-original", !!originalUrl);
  if (!originalUrl) {
    originalFrame.removeAttribute("src");
  }
  renderContent(data);

  if (data.mp3_url) {
    downloadLink.href = data.mp3_url;
    downloadLink.hidden = false;
  } else {
    downloadLink.hidden = true;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("s", currentSessionId);
  window.history.replaceState({}, "", url);
}

shareBtn.addEventListener("click", async () => {
  if (!currentSessionId) return;
  try {
    await navigator.clipboard.writeText(window.location.href);
    const original = shareBtn.textContent;
    shareBtn.textContent = "✅ Link copiat!";
    setTimeout(() => {
      shareBtn.textContent = original;
    }, 1800);
  } catch (err) {
    statusEl.textContent = "Nu s-a putut copia linkul automat — copiază-l manual din bara de adresă.";
  }
});

(async function initFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("s");
  if (!sessionId) return;
  const initialVersion = selectionVersion;

  statusEl.textContent = "Se încarcă documentul partajat...";
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Documentul nu mai este disponibil.");
    }
    const data = await res.json();
    if (selectionVersion !== initialVersion) return;
    const job = documents.find((entry) => entry.sessionId === data.session_id) || addDocument(data.filename || "Document partajat");
    readyDocument(job, { session_id: data.session_id, name: job.name }, data);
    applySessionData(data);
    const requestedPage = Number(params.get("p") || 1);
    if (Number.isInteger(requestedPage) && requestedPage >= 1 && requestedPage <= readerPages.length) {
      showPage(requestedPage, false);
    }
    statusEl.textContent = `Document partajat încărcat: ${sentences.length} propoziții.`;
  } catch (err) {
    if (selectionVersion === initialVersion) statusEl.textContent = `Eroare: ${err.message}`;
  }
})();

loadLibrary();

function renderContent(data) {
  sentences = data.sentences;
  readerPages = [];
  sentencePages.clear();
  const lastSourcePage = sentences.reduce((last, sentence) => Math.max(last, sentence.page || 0), 0);
  const sourcePages = !!originalUrl || lastSourcePage > 0;
  if (sourcePages) {
    const total = Math.max(1, data.page_count || 0, lastSourcePage);
    readerPages = Array.from({ length: total }, () => []);
    data.blocks.forEach((block) => {
      let fragment = null;
      block.sentence_indices.forEach((index) => {
        const page = sentences[index].page || block.page || 1;
        if (!fragment || fragment.page !== page) {
          fragment = { ...block, page, sentence_indices: [] };
          readerPages[page - 1].push(fragment);
        }
        fragment.sentence_indices.push(index);
        sentencePages.set(index, page);
      });
    });
  } else {
    readerPages.push([]);
    let characters = 0;
    data.blocks.forEach((block) => {
      let fragment = null;
      block.sentence_indices.forEach((index) => {
        const length = sentences[index].text.length + 1;
        if (characters && characters + length > READER_PAGE_CHARACTERS) {
          readerPages.push([]);
          characters = 0;
          fragment = null;
        }
        if (!fragment) {
          fragment = { ...block, sentence_indices: [] };
          readerPages[readerPages.length - 1].push(fragment);
        }
        fragment.sentence_indices.push(index);
        sentencePages.set(index, readerPages.length);
        characters += length;
      });
    });
  }
  pageKindEl.textContent = sourcePages ? "Pagini din documentul original" : "Pagini de lectură";
  currentPage = 0;
  showPage(1, false);
}

function showPage(page, stop = true) {
  if (!Number.isInteger(page) || page < 1 || page > readerPages.length) {
    pageInput.value = currentPage;
    statusEl.textContent = `Introdu o pagină între 1 și ${readerPages.length}.`;
    return;
  }
  if (page === currentPage) return;
  if (stop) stopPlayback();
  clearHighlights();
  currentPage = page;
  textContainer.innerHTML = "";
  sentenceElements.clear();

  readerPages[page - 1].forEach((block) => {
    const level = Math.min(Math.max(block.level || 2, 1), 6);
    const tag = block.type === "heading" ? `h${level}` : "p";
    const blockEl = document.createElement(tag);

    block.sentence_indices.forEach((idx) => {
      blockEl.appendChild(buildSentenceEl(sentences[idx]));
    });

    textContainer.appendChild(blockEl);
  });
  if (!sentenceElements.size) {
    const empty = document.createElement("p");
    empty.className = "status";
    empty.textContent = "Această pagină nu conține text care poate fi citit.";
    textContainer.appendChild(empty);
  }
  textContainer.scrollTop = 0;
  pageInput.value = page;
  pageInput.max = readerPages.length;
  pageCountEl.textContent = `/ ${readerPages.length}`;
  prevPageBtn.disabled = page === 1;
  nextPageBtn.disabled = page === readerPages.length;
  if (currentIndex === -1) playBtn.disabled = !sentenceElements.size;
  showOriginalPage(page);
  const url = new URL(window.location.href);
  url.searchParams.set("s", currentSessionId);
  url.searchParams.set("p", page);
  window.history.replaceState({}, "", url);
}

prevPageBtn.addEventListener("click", () => showPage(currentPage - 1));
nextPageBtn.addEventListener("click", () => showPage(currentPage + 1));
pageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  showPage(Number(pageInput.value));
});

function buildSentenceEl(s) {
  const sentenceEl = document.createElement("span");
  sentenceEl.className = "sentence";
  sentenceEl.dataset.index = s.index;
  sentenceEl.dataset.length = s.text.length;
  sentenceElements.set(s.index, sentenceEl);

  // Runs carry the original formatting (highlight, bold, italic, underline).
  const runs = s.runs && s.runs.length ? s.runs : [{ t: s.text }];
  let offset = 0;
  runs.forEach((run) => {
    run.t.split(/(\s+)/).forEach((token) => {
      if (token === "") return;
      if (token.trim() === "") {
        sentenceEl.appendChild(document.createTextNode(token));
      } else {
        const wordEl = document.createElement("span");
        wordEl.className = "word";
        wordEl.dataset.start = offset;
        wordEl.textContent = token;
        if (run.hl) {
          wordEl.classList.add("hl");
          wordEl.style.setProperty("--hl", run.hl);
        }
        if (run.b) wordEl.classList.add("b");
        if (run.i) wordEl.classList.add("i");
        if (run.u) wordEl.classList.add("u");
        sentenceEl.appendChild(wordEl);
      }
      offset += token.length;
    });
  });

  sentenceEl.appendChild(document.createTextNode(" "));
  return sentenceEl;
}

function getSentenceEl(index) {
  return sentenceElements.get(index);
}

function clearHighlights() {
  if (activeSentenceEl) activeSentenceEl.classList.remove("active");
  if (activeWordEl) activeWordEl.classList.remove("active");
  activeSentenceEl = null;
  activeWordEl = null;
}

function playSentence(index, startFraction = 0) {
  if (index < 0 || index >= sentences.length) {
    stopPlayback();
    return;
  }
  clearHighlights();
  showPage(sentencePages.get(index), false);
  currentIndex = index;
  const sentence = sentences[index];
  const sentenceEl = getSentenceEl(index);
  if (sentenceEl) {
    activeSentenceEl = sentenceEl;
    sentenceEl.classList.add("active");
    sentenceEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  showOriginalPage(sentence.page);

  audio.src = sentence.audio_url;
  audio.playbackRate = playbackRate;

  audio.onloadedmetadata = startFraction > 0
    ? () => { audio.currentTime = startFraction * audio.duration; }
    : null;
  startAudio();

  playBtn.disabled = true;
  pauseBtn.disabled = false;
  stopBtn.disabled = false;
}

function showOriginalPage(page) {
  if (!originalUrl || !page || page === shownPage) return;
  shownPage = page;
  originalFrame.src = `${originalUrl}#page=${page}`;
}

function seekTo(index, startFraction = 0) {
  if (index === currentIndex && audio.duration) {
    audio.currentTime = startFraction * audio.duration;
    startAudio();
    playBtn.disabled = true;
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
  } else {
    playSentence(index, startFraction);
  }
}

textContainer.addEventListener("click", (e) => {
  const sentenceEl = e.target.closest(".sentence");
  if (!sentenceEl) return;

  const index = parseInt(sentenceEl.dataset.index, 10);
  const wordEl = e.target.closest(".word");
  let startFraction = 0;
  if (wordEl) {
    const length = parseInt(sentenceEl.dataset.length, 10);
    startFraction = length ? parseInt(wordEl.dataset.start, 10) / length : 0;
  }

  seekTo(index, startFraction);
});

audio.addEventListener("timeupdate", () => {
  if (currentIndex < 0) return;
  const sentenceEl = getSentenceEl(currentIndex);
  if (!sentenceEl || !audio.duration) return;
  const words = sentenceEl.querySelectorAll(".word");
  if (words.length === 0) return;

  const length = parseInt(sentenceEl.dataset.length, 10);
  const pos = Math.min(audio.currentTime / audio.duration, 1) * length;
  let current = words[0];
  for (const w of words) {
    if (parseInt(w.dataset.start, 10) <= pos) current = w;
    else break;
  }

  if (activeWordEl !== current) {
    if (activeWordEl) activeWordEl.classList.remove("active");
    activeWordEl = current;
    activeWordEl.classList.add("active");
  }
});

audio.addEventListener("ended", () => {
  if (currentIndex >= 0) playSentence(currentIndex + 1);
});

function startAudio() {
  const request = ++playbackRequest;
  audio.play().catch((error) => {
    // Changing a page or sentence interrupts pending play requests normally.
    if (request !== playbackRequest || error.name === "AbortError") return;
    statusEl.textContent = "Nu s-a putut reda audio. Apasă Play pentru a reîncerca.";
    playBtn.disabled = !sentenceElements.size;
    pauseBtn.disabled = true;
  });
}

playBtn.addEventListener("click", () => {
  if (currentIndex === -1) {
    const firstIndex = readerPages[currentPage - 1]?.[0]?.sentence_indices[0];
    if (firstIndex !== undefined) playSentence(firstIndex);
  } else {
    startAudio();
    playBtn.disabled = true;
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
  }
});

pauseBtn.addEventListener("click", () => {
  playbackRequest += 1;
  audio.pause();
  playBtn.disabled = !sentenceElements.size;
  pauseBtn.disabled = true;
});

stopBtn.addEventListener("click", stopPlayback);

function stopPlayback() {
  playbackRequest += 1;
  audio.pause();
  audio.onloadedmetadata = null;
  audio.currentTime = 0;
  currentIndex = -1;
  clearHighlights();
  playBtn.disabled = !sentenceElements.size;
  pauseBtn.disabled = true;
  stopBtn.disabled = true;
}

speedSlider.addEventListener("input", () => {
  playbackRate = parseFloat(speedSlider.value);
  speedValue.textContent = `${playbackRate.toFixed(1)}x`;
  audio.playbackRate = playbackRate;
});
