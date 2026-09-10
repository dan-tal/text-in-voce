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
const shareBtn = document.getElementById("share-btn");

let sentences = [];
let currentIndex = -1;
let playbackRate = 1.0;
let currentSessionId = null;
const audio = new Audio();

const versionEl = document.getElementById("app-version");
if (versionEl && window.APP_VERSION) {
  versionEl.textContent = `v${window.APP_VERSION}`;
}

uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;

  uploadBtn.disabled = true;
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
  }
});

function applySessionData(data) {
  currentSessionId = data.session_id;
  renderContent(data);
  playerSection.hidden = false;

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

  const words = s.text.split(/(\s+)/); // keep whitespace tokens
  words.forEach((token) => {
    if (token.trim() === "") {
      sentenceEl.appendChild(document.createTextNode(token));
    } else {
      const wordEl = document.createElement("span");
      wordEl.className = "word";
      wordEl.textContent = token;
      sentenceEl.appendChild(wordEl);
    }
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
    const words = Array.from(sentenceEl.querySelectorAll(".word"));
    const wordIdx = words.indexOf(wordEl);
    if (wordIdx > 0) startFraction = wordIdx / words.length;
  }

  seekTo(index, startFraction);
});

audio.addEventListener("timeupdate", () => {
  if (currentIndex < 0) return;
  const sentenceEl = getSentenceEl(currentIndex);
  if (!sentenceEl || !audio.duration) return;
  const words = sentenceEl.querySelectorAll(".word");
  if (words.length === 0) return;

  const progress = Math.min(audio.currentTime / audio.duration, 1);
  const wordIndex = Math.min(Math.floor(progress * words.length), words.length - 1);

  words.forEach((w) => w.classList.remove("active"));
  words[wordIndex].classList.add("active");
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
