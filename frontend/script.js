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

let sentences = [];
let currentIndex = -1;
let playbackRate = 1.0;
let currentSessionId = null;
let originalUrl = null;
let shownPage = null;
const audio = new Audio();

const versionEl = document.getElementById("app-version");
if (versionEl && window.APP_VERSION) {
  versionEl.textContent = `v${window.APP_VERSION}`;
}

uploadForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const file = fileInput.files[0];
  if (file) uploadFile(file);
});

async function uploadFile(file) {
  uploadBtn.disabled = true;
  pasteSubmit.disabled = true;
  statusEl.textContent = "Se procesează fișierul și se generează audio... poate dura câteva zeci de secunde.";
  playerSection.hidden = true;
  stopPlayback();

  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Eroare server (${res.status})`);
    }
    const data = await res.json();
    applySessionData(data);
    statusEl.textContent = `Gata: ${sentences.length} propoziții generate.`;
  } catch (err) {
    statusEl.textContent = `Eroare: ${err.message}`;
  } finally {
    uploadBtn.disabled = false;
    pasteSubmit.disabled = false;
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
  uploadFile(new File([text], "text-lipit.txt", { type: "text/plain" }));
});

function applySessionData(data) {
  currentSessionId = data.session_id;
  renderContent(data);
  playerSection.hidden = false;

  originalUrl = data.original_url || null;
  shownPage = null;
  originalPane.hidden = !originalUrl;
  readerLayout.classList.toggle("with-original", !!originalUrl);
  if (originalUrl) {
    const firstPage = (data.sentences.find((x) => x.page) || {}).page || 1;
    showOriginalPage(firstPage);
  } else {
    originalFrame.removeAttribute("src");
  }

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

  statusEl.textContent = "Se încarcă documentul partajat...";
  try {
    const res = await fetch(`/api/session/${sessionId}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Documentul nu mai este disponibil.");
    }
    const data = await res.json();
    applySessionData(data);
    statusEl.textContent = `Document partajat încărcat: ${sentences.length} propoziții.`;
  } catch (err) {
    statusEl.textContent = `Eroare: ${err.message}`;
  }
})();

function renderContent(data) {
  sentences = data.sentences;
  textContainer.innerHTML = "";

  data.blocks.forEach((block) => {
    const level = Math.min(Math.max(block.level || 2, 1), 6);
    const tag = block.type === "heading" ? `h${level}` : "p";
    const blockEl = document.createElement(tag);

    block.sentence_indices.forEach((idx) => {
      blockEl.appendChild(buildSentenceEl(sentences[idx]));
    });

    textContainer.appendChild(blockEl);
  });
}

function buildSentenceEl(s) {
  const sentenceEl = document.createElement("span");
  sentenceEl.className = "sentence";
  sentenceEl.dataset.index = s.index;
  sentenceEl.dataset.length = s.text.length;

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
  return textContainer.querySelector(`.sentence[data-index="${index}"]`);
}

function clearHighlights() {
  textContainer.querySelectorAll(".sentence.active").forEach((el) => el.classList.remove("active"));
  textContainer.querySelectorAll(".word.active").forEach((el) => el.classList.remove("active"));
}

function playSentence(index, startFraction = 0) {
  if (index < 0 || index >= sentences.length) {
    stopPlayback();
    return;
  }
  clearHighlights();
  currentIndex = index;
  const sentence = sentences[index];
  const sentenceEl = getSentenceEl(index);
  if (sentenceEl) {
    sentenceEl.classList.add("active");
    sentenceEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  showOriginalPage(sentence.page);

  audio.src = sentence.audio_url;
  audio.playbackRate = playbackRate;

  if (startFraction > 0) {
    audio.addEventListener(
      "loadedmetadata",
      () => {
        audio.currentTime = startFraction * audio.duration;
      },
      { once: true }
    );
  }
  audio.play();

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
    audio.play();
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

  words.forEach((w) => w.classList.remove("active"));
  current.classList.add("active");
});

audio.addEventListener("ended", () => {
  playSentence(currentIndex + 1);
});

playBtn.addEventListener("click", () => {
  if (currentIndex === -1) {
    playSentence(0);
  } else {
    audio.play();
    playBtn.disabled = true;
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
  }
});

pauseBtn.addEventListener("click", () => {
  audio.pause();
  playBtn.disabled = false;
  pauseBtn.disabled = true;
});

stopBtn.addEventListener("click", stopPlayback);

function stopPlayback() {
  audio.pause();
  audio.currentTime = 0;
  currentIndex = -1;
  clearHighlights();
  playBtn.disabled = false;
  pauseBtn.disabled = true;
  stopBtn.disabled = true;
}

speedSlider.addEventListener("input", () => {
  playbackRate = parseFloat(speedSlider.value);
  speedValue.textContent = `${playbackRate.toFixed(1)}x`;
  audio.playbackRate = playbackRate;
});
