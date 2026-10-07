const uploadForm = document.getElementById("upload-form");
const fileInput = document.getElementById("file-input");
const uploadBtn = document.getElementById("upload-btn");
const statusEl = document.getElementById("status");
const playerSection = document.getElementById("player-section");
const textContainer = document.getElementById("text-container");
const playBtn = document.getElementById("play-btn");
const speedBtn = document.getElementById("speed-btn");
const ownerActions = document.getElementById("owner-actions");
const downloadLink = document.getElementById("download-link");
const pasteBtn = document.getElementById("paste-btn");
const pasteBox = document.getElementById("paste-box");
const pasteText = document.getElementById("paste-text");
const pasteSubmit = document.getElementById("paste-submit");
const shareBtn = document.getElementById("share-btn");
const prevPageBtn = document.getElementById("prev-page");
const nextPageBtn = document.getElementById("next-page");
const pageForm = document.getElementById("page-form");
const pageInput = document.getElementById("page-input");
const pageCountEl = document.getElementById("page-count");
const READER_PAGE_CHARACTERS = 3000;
let readerPages = [];
let currentPage = 0;
const sentencePages = new Map();
const recentDocumentList = document.getElementById("recent-document-list");
const recentDocumentsHint = document.getElementById("recent-documents-hint");
const recentDocuments = [];
const MAX_RECENT_DOCUMENTS = 3;
const documentDialog = document.getElementById("document-dialog");
const dialogForm = document.getElementById("document-dialog-form");
const dialogTitle = document.getElementById("document-dialog-title");
const dialogDescription = document.getElementById("document-dialog-description");
const dialogError = document.getElementById("document-dialog-error");
const dialogSubmit = document.getElementById("document-dialog-submit");
const dialogCancel = document.getElementById("document-dialog-cancel");
let dialogJob = null;
let dialogBusy = false;
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
const SPEEDS = [0.75, 1, 1.25, 1.5, 2, 3];
let playbackRate = 1.0;
let playing = false;
let currentSessionId = null;
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
    if (job.state === "ready") confirmDeletion(job);
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
  view.stateEl.textContent = job.statusText;
  view.button.textContent = job.buttonText;
  view.button.disabled = job.disabled;
  view.deleteButton.disabled = job.state === "processing";
  view.deleteButton.textContent = job.state === "ready" ? "Șterge" : "Elimină";
  view.deleteButton.title = job.state === "processing" ? "Poți șterge documentul după terminarea procesării" :
    "Șterge definitiv documentul și fișierele audio";
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
  if (job.disabled || job.removed) return;
  if (job.state === "ready") openDocument(job);
  else if (job.state === "failed") {
    job.state = "queued";
    job.statusText = "În așteptare";
    job.disabled = true;
    syncRecentDocument(job);
    uploadQueue.push(job);
    pumpUploads();
  }
}

function addDocument(name) {
  const job = { name, state: "queued", statusText: "În așteptare", buttonText: "Deschide",
    disabled: true, file: null, sessionId: null, removed: false };
  documents.push(job);
  return job;
}

function readyDocument(job, data) {
  job.sessionId = data.session_id;
  job.state = "ready";
  job.file = null;
  job.statusText = `Gata: ${data.sentences.length} propoziții`;
  job.buttonText = "Deschide";
  job.disabled = false;
  syncRecentDocument(job);
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
  const version = ++selectionVersion;
  openingDocument = job;
  job.disabled = true;
  syncRecentDocument(job);
  try {
    // Fetch each time: another visitor may have deleted a shared document.
    const data = await requestJson(`/api/session/${encodeURIComponent(job.sessionId)}`);
    if (job.removed || version !== selectionVersion) return;
    applySessionData(data, !job.isUpload);
  } catch (error) {
    statusEl.textContent = `Nu s-a putut deschide documentul: ${error.message}`;
  } finally {
    job.disabled = false;
    syncRecentDocument(job);
    if (openingDocument === job) openingDocument = null;
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
  if (openingDocument === job) { openingDocument = null; selectionVersion += 1; }
  if (job.sessionId && job.sessionId === currentSessionId) {
    selectionVersion += 1;
    stopPlayback();
    currentSessionId = null;
    sentences = [];
    readerPages = [];
    sentenceElements.clear();
    sentencePages.clear();
    resetRemarks();
    textContainer.replaceChildren();
    playerSection.hidden = true;
    downloadLink.removeAttribute("href");
    const url = new URL(window.location.href);
    url.searchParams.delete("s"); url.searchParams.delete("p");
    window.history.replaceState({}, "", url);
  }
  updateUploadStatus();
}

function confirmDeletion(job) {
  dialogJob = job;
  dialogTitle.textContent = "Ștergi documentul?";
  dialogDescription.textContent = `„${job.name}” și fișierele audio vor fi șterse definitiv. Linkul partajat nu va mai funcționa.`;
  dialogError.textContent = "";
  dialogSubmit.textContent = "Șterge definitiv";
  dialogSubmit.classList.add("danger-btn");
  documentDialog.showModal();
}

dialogCancel.addEventListener("click", () => documentDialog.close());
documentDialog.addEventListener("cancel", (event) => { if (dialogBusy) event.preventDefault(); });

dialogForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (dialogBusy || !dialogJob || dialogJob.removed) return;
  const job = dialogJob;
  dialogBusy = true;
  dialogSubmit.disabled = dialogCancel.disabled = true;
  if (currentSessionId === job.sessionId) stopPlayback();
  try {
    await requestJson(`/api/library/${encodeURIComponent(job.sessionId)}`, { method: "DELETE" });
    removeDocument(job);
    documentDialog.close();
    statusEl.textContent = "Documentul și fișierele audio au fost șterse.";
  } catch (error) {
    if (error.status === 404) {
      removeDocument(job);
      documentDialog.close();
      statusEl.textContent = "Documentul a fost deja șters.";
    } else dialogError.textContent = error.message;
  } finally {
    dialogBusy = false;
    dialogSubmit.disabled = dialogCancel.disabled = false;
  }
});

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
    job.statusText = "Se trimite și se generează audio...";
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
    readyDocument(job, data);
    if (!currentSessionId && !openingDocument) applySessionData(data);
  } catch (err) {
    job.state = "failed";
    job.statusText = `Eroare: ${err.message}`;
    job.buttonText = "Reîncearcă";
    job.disabled = false;
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

// Only the person who just generated a document may share it or take its MP3.
function applySessionData(data, shared = false) {
  selectionVersion += 1;
  stopPlayback();
  currentSessionId = data.session_id;
  documents.forEach(syncRecentDocument);
  playerSection.hidden = false;

  resetRemarks();
  renderContent(data);
  loadRemarks();

  ownerActions.hidden = shared;
  downloadLink.hidden = !data.mp3_url;
  if (data.mp3_url) downloadLink.href = data.mp3_url;

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
    readyDocument(job, data);
    if (!job.recent) addRecentDocument(job);
    applySessionData(data, !job.isUpload);
    const requestedPage = Number(params.get("p") || 1);
    if (Number.isInteger(requestedPage) && requestedPage >= 1 && requestedPage <= readerPages.length) {
      showPage(requestedPage, false);
    }
    statusEl.textContent = `Document partajat încărcat: ${sentences.length} propoziții.`;
  } catch (err) {
    if (selectionVersion === initialVersion) statusEl.textContent = `Eroare: ${err.message}`;
  }
})();

function renderContent(data) {
  sentences = data.sentences;
  readerPages = [];
  sentencePages.clear();
  const lastSourcePage = sentences.reduce((last, sentence) => Math.max(last, sentence.page || 0), 0);
  const sourcePages = !!data.original_url || lastSourcePage > 0;
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
  paragraphFirst.clear();
  paragraphEls.clear();

  readerPages[page - 1].forEach((block) => {
    const level = Math.min(Math.max(block.level || 2, 1), 6);
    const tag = block.type === "heading" ? `h${level}` : "p";
    const blockEl = document.createElement(tag);

    block.sentence_indices.forEach((idx) => {
      blockEl.appendChild(buildSentenceEl(sentences[idx]));
    });

    textContainer.appendChild(blockEl);
    addRemarkRow(block, blockEl);
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
  if (!playing) playBtn.disabled = !sentenceElements.size;
  updateRemarkTarget();
  const url = new URL(window.location.href);
  url.searchParams.set("s", currentSessionId);
  url.searchParams.set("p", page);
  window.history.replaceState({}, "", url);
}

prevPageBtn.addEventListener("click", () => showPage(currentPage - 1));
nextPageBtn.addEventListener("click", () => showPage(currentPage + 1));
pageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  pageInput.blur();
  showPage(Number(pageInput.value));
});

// Dark highlight colours from the source document need light text.
function readableOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 140 ? "#fff" : "#000";
}

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
          wordEl.style.setProperty("--hl-fg", readableOn(run.hl));
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
  lastSentenceIndex = index;
  updateRemarkTarget();
  const sentence = sentences[index];
  const sentenceEl = getSentenceEl(index);
  if (sentenceEl) {
    activeSentenceEl = sentenceEl;
    sentenceEl.classList.add("active");
    sentenceEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  audio.src = sentence.audio_url;
  audio.playbackRate = playbackRate;

  audio.onloadedmetadata = startFraction > 0
    ? () => { audio.currentTime = startFraction * audio.duration; }
    : null;
  startAudio();
}

function seekTo(index, startFraction = 0) {
  if (index === currentIndex && audio.duration) {
    audio.currentTime = startFraction * audio.duration;
    startAudio();
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

// One button plays and pauses; the label always shows what a tap will do.
function setPlaying(on) {
  playing = on;
  playBtn.textContent = on ? "⏸" : "▶";
  playBtn.setAttribute("aria-label", on ? "Pauză" : "Redare");
  playBtn.disabled = !on && !sentenceElements.size;
}

function startAudio() {
  stopRemarkPlayback();
  const request = ++playbackRequest;
  setPlaying(true);
  audio.play().catch((error) => {
    // Changing a page or sentence interrupts pending play requests normally.
    if (request !== playbackRequest || error.name === "AbortError") return;
    statusEl.textContent = "Nu s-a putut reda audio. Apasă Play pentru a reîncerca.";
    setPlaying(false);
  });
}

playBtn.addEventListener("click", () => {
  if (playing) pausePlayback();
  else if (currentIndex === -1) {
    const firstIndex = readerPages[currentPage - 1]?.[0]?.sentence_indices[0];
    if (firstIndex !== undefined) playSentence(firstIndex);
  } else startAudio();
});

function pausePlayback() {
  playbackRequest += 1;
  audio.pause();
  setPlaying(false);
}

function stopPlayback() {
  playbackRequest += 1;
  audio.pause();
  audio.onloadedmetadata = null;
  audio.currentTime = 0;
  currentIndex = -1;
  clearHighlights();
  setPlaying(false);
}

speedBtn.addEventListener("click", () => {
  playbackRate = SPEEDS[(SPEEDS.indexOf(playbackRate) + 1) % SPEEDS.length];
  speedBtn.textContent = `${playbackRate}x`;
  audio.playbackRate = playbackRate;
});

// ---- Audio remarks: record a voice note on the paragraph where playback stopped ----
const remarkDockBtn = document.getElementById("remark-dock-btn");
const remarkDockTarget = document.getElementById("remark-dock-target");
const remarkSheet = document.getElementById("remark-sheet");
const remarkSheetTarget = document.getElementById("remark-sheet-target");
const remarkRecordingStage = document.getElementById("remark-recording");
const remarkReviewStage = document.getElementById("remark-review");
const remarkTimerEl = document.getElementById("remark-timer");
const remarkStopBtn = document.getElementById("remark-stop");
const remarkPreview = document.getElementById("remark-preview");
const remarkAuthor = document.getElementById("remark-author");
const remarkSaveBtn = document.getElementById("remark-save");
const remarkRedoBtn = document.getElementById("remark-redo");
const remarkCancelBtn = document.getElementById("remark-cancel");
const remarkErrorEl = document.getElementById("remark-error");
const remarkFileInput = document.getElementById("remark-file");
const MAX_REMARK_SECONDS = 180;
const AUTHOR_KEY = "text-in-voce-author";
const remarksBySentence = new Map();   // first sentence of a paragraph -> remarks
const paragraphFirst = new Map();      // sentence index -> first sentence of its paragraph
const paragraphEls = new Map();        // first sentence -> { blockEl, row, list }
let lastSentenceIndex = -1;
let remarkAudio = null;
let playingRemark = null;
let remarksVersion = 0;
let recording = null;                  // { target, recorder, stream, chunks, started, timer, wakeLock }
let draft = null;                      // { target, blob, seconds } waiting to be saved
let remarkBusy = false;
let pendingFileTarget = null;          // paragraph awaiting a file from the phone's own recorder

function formatSeconds(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function snippet(index) {
  const text = sentences[index]?.text || "";
  return text.length > 70 ? `${text.slice(0, 67)}…` : text;
}

function resetRemarks() {
  remarksVersion += 1;
  stopRemarkPlayback();
  remarksBySentence.clear();
  paragraphFirst.clear();
  paragraphEls.clear();
  lastSentenceIndex = -1;
  updateRemarkTarget();
}

async function loadRemarks() {
  const sessionId = currentSessionId;
  if (!sessionId) return;
  const version = ++remarksVersion;
  try {
    const result = await requestJson(`/api/session/${encodeURIComponent(sessionId)}/remarks`);
    if (version !== remarksVersion || sessionId !== currentSessionId) return;
    remarksBySentence.clear();
    result.remarks.forEach((remark) => {
      if (!remarksBySentence.has(remark.sentence_index)) remarksBySentence.set(remark.sentence_index, []);
      remarksBySentence.get(remark.sentence_index).push(remark);
    });
    paragraphEls.forEach((_, first) => renderRemarkRow(first));
  } catch (error) {
    // Reading the document must keep working even if remarks cannot be fetched.
  }
}

function addRemarkRow(block, blockEl) {
  const first = block.sentence_indices[0];
  block.sentence_indices.forEach((index) => paragraphFirst.set(index, first));
  const row = document.createElement("div");
  row.className = "remark-row";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "remark-add";
  add.setAttribute("aria-label", "Înregistrează o remarcă vocală pentru acest paragraf");
  add.addEventListener("click", () => startRemark(first));
  const list = document.createElement("span");
  list.className = "remark-list";
  row.append(add, list);
  textContainer.appendChild(row);
  paragraphEls.set(first, { blockEl, row, list });
  renderRemarkRow(first);
}

function renderRemarkRow(first) {
  const view = paragraphEls.get(first);
  if (!view) return;
  const items = remarksBySentence.get(first) || [];
  view.row.classList.toggle("has-remarks", items.length > 0);
  view.list.replaceChildren(...items.map((remark) => {
    const chip = document.createElement("span");
    chip.className = "remark-chip";
    chip.classList.toggle("playing", playingRemark === remark.id);
    const play = document.createElement("button");
    play.type = "button";
    play.className = "remark-play";
    play.textContent = `${playingRemark === remark.id ? "⏸" : "▶"} ${remark.duration ? formatSeconds(remark.duration) : "Ascultă"}`;
    play.setAttribute("aria-label", `Ascultă remarca${remark.author ? ` de la ${remark.author}` : ""}`);
    play.addEventListener("click", () => toggleRemark(remark));
    chip.append(play);
    if (remark.author) {
      const author = document.createElement("span");
      author.className = "remark-author";
      author.textContent = remark.author;
      chip.append(author);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "remark-del";
    del.textContent = "✕";
    del.setAttribute("aria-label", "Șterge remarca");
    del.addEventListener("click", () => deleteRemark(remark));
    chip.append(del);
    return chip;
  }));
}

function remarkTargetIndex() {
  const first = paragraphFirst.get(currentIndex >= 0 ? currentIndex : lastSentenceIndex);
  if (first !== undefined) return first;
  return readerPages[currentPage - 1]?.[0]?.sentence_indices[0];
}

function updateRemarkTarget() {
  const target = remarkTargetIndex();
  paragraphEls.forEach((view, first) => view.blockEl.classList.toggle("remark-target", first === target));
  remarkDockBtn.disabled = target === undefined || remarkBusy;
  remarkDockTarget.textContent = target === undefined ? "" : `La: „${snippet(target)}”`;
}

remarkDockBtn.addEventListener("click", () => {
  const target = remarkTargetIndex();
  if (target !== undefined) startRemark(target);
});

function stopRemarkPlayback() {
  if (!remarkAudio || playingRemark === null) return;
  remarkAudio.pause();
  playingRemark = null;
  paragraphEls.forEach((_, first) => renderRemarkRow(first));
}

function toggleRemark(remark) {
  if (playingRemark === remark.id) { stopRemarkPlayback(); return; }
  stopRemarkPlayback();
  if (playing) pausePlayback();
  if (!remarkAudio) {
    remarkAudio = new Audio();
    remarkAudio.addEventListener("ended", stopRemarkPlayback);
  }
  remarkAudio.src = remark.audio_url;
  remarkAudio.playbackRate = 1;
  playingRemark = remark.id;
  remarkAudio.play().catch(() => {
    stopRemarkPlayback();
    statusEl.textContent = "Nu s-a putut reda remarca audio.";
  });
  paragraphEls.forEach((_, first) => renderRemarkRow(first));
}

async function deleteRemark(remark) {
  if (!window.confirm("Ștergi această remarcă pentru toți utilizatorii?")) return;
  if (playingRemark === remark.id) stopRemarkPlayback();
  try {
    await requestJson(`/api/session/${encodeURIComponent(currentSessionId)}/remarks/${encodeURIComponent(remark.id)}`, { method: "DELETE" });
  } catch (error) {
    if (error.status !== 404) { statusEl.textContent = `Remarca nu a putut fi ștearsă: ${error.message}`; return; }
  }
  loadRemarks();
}

function showRemarkStage(stage) {
  remarkSheet.hidden = stage === null;
  remarkRecordingStage.hidden = stage !== "recording";
  remarkReviewStage.hidden = stage !== "review";
  document.body.classList.toggle("sheet-open", stage !== null);
  if (stage === "recording") remarkStopBtn.focus();
  if (stage === "review") remarkSaveBtn.focus();
}

function remarkError(message) {
  remarkErrorEl.textContent = message;
}

function pickRecorderType() {
  const types = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];
  return types.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
}

async function startRemark(target) {
  if (recording || draft || remarkBusy) return;
  stopRemarkPlayback();
  if (playing) pausePlayback();
  remarkSheetTarget.textContent = `„${snippet(target)}”`;
  remarkError("");
  // Without a secure context the browser hides the microphone API; phones can
  // still record through their own audio app via a capture file input.
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    pendingFileTarget = target;
    remarkFileInput.value = "";
    remarkFileInput.click();
    return;
  }
  remarkBusy = true;
  updateRemarkTarget();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const type = pickRecorderType();
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const state = { target, recorder, stream, chunks: [], started: Date.now(), timer: null, wakeLock: null, cancelled: false };
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) state.chunks.push(event.data); });
    recorder.addEventListener("stop", () => finishRecording(state));
    recorder.start(1000);
    recording = state;
    remarkTimerEl.textContent = "0:00";
    state.timer = setInterval(() => {
      const seconds = (Date.now() - state.started) / 1000;
      remarkTimerEl.textContent = formatSeconds(seconds);
      if (seconds >= MAX_REMARK_SECONDS) stopRecording();
    }, 250);
    navigator.wakeLock?.request("screen").then((lock) => { state.wakeLock = lock; }).catch(() => {});
    navigator.vibrate?.(30);
    showRemarkStage("recording");
  } catch (error) {
    remarkBusy = false;
    updateRemarkTarget();
    statusEl.textContent = error.name === "NotAllowedError" || error.name === "SecurityError" ?
      "Microfonul este blocat. Permite accesul la microfon în setările browserului și încearcă din nou." :
      error.name === "NotFoundError" ? "Nu s-a găsit niciun microfon pe acest dispozitiv." :
      `Nu s-a putut porni înregistrarea: ${error.message}`;
  }
}

function releaseRecording(state) {
  clearInterval(state.timer);
  state.stream.getTracks().forEach((track) => track.stop());
  state.wakeLock?.release().catch(() => {});
}

function stopRecording() {
  if (recording?.recorder.state === "recording") recording.recorder.stop();
}

function finishRecording(state) {
  releaseRecording(state);
  const seconds = (Date.now() - state.started) / 1000;
  if (recording === state) recording = null;
  if (state.cancelled) return;
  const blob = new Blob(state.chunks, { type: state.recorder.mimeType || "audio/webm" });
  if (!blob.size) {
    remarkBusy = false;
    showRemarkStage(null);
    updateRemarkTarget();
    statusEl.textContent = "Înregistrarea este goală. Încearcă din nou.";
    return;
  }
  navigator.vibrate?.(20);
  reviewDraft({ target: state.target, blob, seconds });
}

function reviewDraft(next) {
  draft = next;
  remarkBusy = true;
  if (remarkPreview.src) URL.revokeObjectURL(remarkPreview.src);
  remarkPreview.src = URL.createObjectURL(draft.blob);
  try { remarkAuthor.value = localStorage.getItem(AUTHOR_KEY) || ""; } catch (error) { /* storage blocked */ }
  showRemarkStage("review");
}

function closeRemark() {
  if (recording) {
    recording.cancelled = true;
    if (recording.recorder.state === "recording") recording.recorder.stop();
    else releaseRecording(recording);
    recording = null;
  }
  draft = null;
  remarkBusy = false;
  remarkPreview.pause();
  if (remarkPreview.src) URL.revokeObjectURL(remarkPreview.src);
  remarkPreview.removeAttribute("src");
  showRemarkStage(null);
  updateRemarkTarget();
}

remarkFileInput.addEventListener("change", () => {
  const file = remarkFileInput.files[0];
  const target = pendingFileTarget;
  pendingFileTarget = null;
  if (file && target !== null) reviewDraft({ target, blob: file, seconds: null });
});
remarkStopBtn.addEventListener("click", stopRecording);
remarkCancelBtn.addEventListener("click", closeRemark);
remarkRedoBtn.addEventListener("click", () => {
  const target = draft?.target;
  closeRemark();
  if (target !== undefined) startRemark(target);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !remarkSheet.hidden) closeRemark();
});

remarkSaveBtn.addEventListener("click", async () => {
  if (!draft || remarkSaveBtn.disabled) return;
  const sessionId = currentSessionId;
  const author = remarkAuthor.value.trim();
  const extension = (draft.blob.type.split(";")[0].split("/")[1] || "webm").replace("x-", "");
  const form = new FormData();
  form.append("audio", draft.blob, `remarca.${extension}`);
  form.append("sentence_index", String(draft.target));
  if (draft.seconds) form.append("duration", draft.seconds.toFixed(1));
  form.append("author", author);
  remarkSaveBtn.disabled = remarkRedoBtn.disabled = true;
  remarkSaveBtn.textContent = "Se salvează...";
  remarkError("");
  try {
    await requestJson(`/api/session/${encodeURIComponent(sessionId)}/remarks`, { method: "POST", body: form });
    try { localStorage.setItem(AUTHOR_KEY, author); } catch (error) { /* storage blocked */ }
    const target = draft.target;
    closeRemark();
    statusEl.textContent = "Remarca a fost salvată.";
    await loadRemarks();
    paragraphEls.get(target)?.row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (error) {
    // Keep the recording so a network hiccup does not lose it.
    remarkError(`Remarca nu a fost salvată: ${error.message}`);
  } finally {
    remarkSaveBtn.disabled = remarkRedoBtn.disabled = false;
    remarkSaveBtn.textContent = "Salvează remarca";
  }
});

// Other visitors may have added remarks while this tab was in the background.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && currentSessionId && !remarkBusy) loadRemarks();
});
