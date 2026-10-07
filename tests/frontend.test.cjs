const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "frontend/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "frontend/style.css"), "utf8");
const script = fs.readFileSync(path.join(root, "frontend/script.js"), "utf8");

async function setup(t, query = "") {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("http://test/**", (route) => new URL(route.request().url()).pathname === "/style.css" ?
    route.fulfill({ contentType: "text/css", body: css }) :
    route.fulfill({ contentType: "text/html", body: html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "") }));
  await page.goto(`http://test/${query}`);
  await page.evaluate(() => {
    window.pendingRequests = [];
    window.sessionResponses = {};
    window.remarkItems = [];
    window.fetch = (url, options = {}) => {
      if (url.endsWith("/remarks") && !options.method) return Promise.resolve({ ok: true, json: async () => ({ remarks: window.remarkItems }) });
      if (url.endsWith("/remarks")) {
        window.savedRemark = { url, fields: Object.fromEntries(options.body.entries()), audioType: options.body.get("audio").type };
        window.remarkItems = [{ id: "r1", sentence_index: Number(options.body.get("sentence_index")), audio_url: "/audio/x/remarks/r1.webm",
          duration: 4, author: options.body.get("author") }];
        return Promise.resolve({ ok: true, status: 201, json: async () => window.remarkItems[0] });
      }
      if (url.includes("/remarks/") && options.method === "DELETE") {
        window.remarkItems = [];
        return Promise.resolve({ ok: true, status: 204 });
      }
      if (url.startsWith("/api/library/") && options.method === "DELETE") return Promise.resolve({ ok: true, status: 204 });
      if (window.sessionResponses[url]) return Promise.resolve({ ok: true, json: async () => window.sessionResponses[url] });
      return new Promise((resolve) => window.pendingRequests.push({ url, options, resolve }));
    };
    window.Audio = class {
      constructor() { window.testAudio = this; this.listeners = {}; this.duration = 1; }
      addEventListener(type, fn) { this.listeners[type] = fn; }
      pause() { this.paused = true; }
      play() { return Promise.resolve(); }
    };
  });
  await page.addScriptTag({ content: script });
  return page;
}

function session(id, extra = {}) {
  return { session_id: id, sentences: [{ index: 0, text: id, duration: 1, audio_url: `/${id}.wav` }],
    blocks: [{ type: "paragraph", sentence_indices: [0] }], mp3_url: `/${id}.mp3`, ...extra };
}

async function submit(page, names) {
  await page.locator("#file-input").setInputFiles(names.map((name) => ({ name, mimeType: "text/plain", buffer: Buffer.from("Salut.") })));
  await page.locator("#upload-btn").click();
}

async function resolve(page, index, id, data = session(id)) {
  await page.evaluate(({ index, id, data }) => {
    window.sessionResponses[`/api/session/${id}`] = data;
    window.pendingRequests[index].resolve({ ok: true, status: 200, json: async () => data });
  }, { index, id, data });
}

test("biblioteca și previzualizarea originalului nu sunt afișate", async (t) => {
  const page = await setup(t);
  assert.equal(await page.locator("#library-section").count(), 0);
  assert.equal(await page.locator("#document-list").count(), 0);
  assert.equal(await page.locator("#original-frame").count(), 0);
  assert.equal(await page.locator("#original-pane").count(), 0);
});

test("încărcările simultane păstrează maximum trei documente recente", async (t) => {
  const page = await setup(t);
  await submit(page, ["one.txt", "two.txt", "three.txt", "four.txt", "five.txt"]);
  assert.equal(await page.evaluate(() => window.pendingRequests.length), 2);
  assert.deepEqual(await page.locator(".recent-document-row .document-name").allTextContents(), ["three.txt", "four.txt", "five.txt"]);
  for (let index = 0; index < 5; index += 1) {
    await page.waitForFunction((n) => window.pendingRequests.length > n, index);
    await resolve(page, index, String(index + 1).repeat(6));
  }
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("5 gata"));
  assert.equal(await page.locator(".recent-document-row").count(), 3);
});

test("paginarea rămâne disponibilă fără iframe-ul original", async (t) => {
  const page = await setup(t, "?s=aaaaaa");
  const data = session("aaaaaa", { page_count: 3, original_url: "/audio/aaaaaa/original.pdf",
    sentences: [{ index: 0, text: "Prima", page: 1, duration: 1, audio_url: "/one.wav" },
      { index: 1, text: "A treia", page: 3, duration: 1, audio_url: "/three.wav" }],
    blocks: [{ type: "paragraph", sentence_indices: [0] }, { type: "paragraph", sentence_indices: [1] }] });
  await resolve(page, 0, "aaaaaa", data);
  await page.waitForFunction(() => !document.querySelector("#player-section").hidden);
  assert.equal(await page.locator("#page-count").textContent(), "/ 3");
  assert.equal(await page.locator("#original-frame").count(), 0);
  await page.locator("#page-input").fill("3");
  await page.locator("#page-form").press("Enter");
  assert.match(await page.locator("#text-container").textContent(), /A treia/);
});

test("ștergerea unui document elimină sesiunea din interfață", async (t) => {
  const page = await setup(t);
  await submit(page, ["one.txt"]);
  await resolve(page, 0, "aaaaaa");
  await page.waitForFunction(() => !document.querySelector("#player-section").hidden);
  await page.locator(".recent-document-row").getByRole("button", { name: "Șterge" }).click();
  await page.getByRole("button", { name: "Șterge definitiv" }).click();
  await page.waitForFunction(() => !document.querySelector("#document-dialog").open);
  assert.equal(await page.locator(".recent-document-row").count(), 0);
  assert.equal(await page.locator("#player-section").isVisible(), false);
  assert.doesNotMatch(page.url(), /s=/);
});

// A shared link is the first pending request; answering it opens the document.
async function openShared(page, data) {
  await resolve(page, 0, data.session_id, data);
  await page.waitForFunction(() => !document.querySelector("#player-section").hidden);
}

const twoParagraphs = {
  session_id: "cccccc",
  sentences: [
    { index: 0, text: "Primul paragraf are o singură propoziție.", duration: 1, audio_url: "/audio/cccccc/0.wav" },
    { index: 1, text: "Al doilea paragraf.", duration: 1, audio_url: "/audio/cccccc/1.wav" },
    { index: 2, text: "Al treilea.", duration: 1, audio_url: "/audio/cccccc/2.wav" },
  ],
  blocks: [{ type: "paragraph", sentence_indices: [0] }, { type: "paragraph", sentence_indices: [1, 2] }],
};

test("remarks target the paragraph where playback stopped and show existing voice notes", async (t) => {
  const page = await setup(t, "?s=cccccc");
  await page.evaluate(() => {
    window.remarkItems = [{ id: "r1", sentence_index: 1, audio_url: "/audio/cccccc/remarks/r1.webm", duration: 65, author: "Ana" }];
  });
  await openShared(page, twoParagraphs);
  await page.waitForSelector("#text-container .remark-row");

  assert.equal(await page.locator(".remark-row").count(), 2);
  assert.match(await page.locator("#remark-dock-target").textContent(), /Primul paragraf/);
  await page.locator('[data-index="2"]').click();           // second paragraph, second sentence
  await page.locator("#play-btn").click();                 // pauses
  assert.match(await page.locator("#remark-dock-target").textContent(), /Al doilea paragraf/);
  assert.equal(await page.locator("#text-container p.remark-target").textContent(), "Al doilea paragraf. Al treilea. ");
  assert.equal(await page.locator(".remark-row.has-remarks .remark-play").textContent(), "▶ 1:05");
  assert.equal(await page.locator(".remark-row.has-remarks .remark-author").textContent(), "Ana");
  // Leaving the page and coming back falls back to its first paragraph.
  await page.evaluate(() => stopPlayback());
  assert.match(await page.locator("#remark-dock-target").textContent(), /Al doilea paragraf/);
});

test("recording pauses the reader, can be reviewed, and saves against the paragraph", async (t) => {
  const page = await setup(t, "?s=cccccc");
  await page.evaluate(() => {
    window.stopped = false;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() { window.stopped = true; } }] }),
    } });
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { this.state = "inactive"; this.mimeType = "audio/webm;codecs=opus"; this.handlers = {}; }
      addEventListener(type, handler) { this.handlers[type] = handler; }
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        this.handlers.dataavailable({ data: new Blob(["voice"], { type: this.mimeType }) });
        this.handlers.stop();
      }
    };
  });
  await openShared(page, twoParagraphs);
  await page.waitForSelector("#text-container .remark-row");

  await page.locator('[data-index="1"]').click();
  await page.locator("#remark-dock-btn").click();
  await page.waitForSelector("#remark-stop", { state: "visible" });
  assert.equal(await page.evaluate(() => window.testAudio.paused), true);
  assert.match(await page.locator("#remark-sheet-target").textContent(), /Al doilea paragraf/);

  await page.locator("#remark-stop").click();
  await page.waitForSelector("#remark-save", { state: "visible" });
  assert.equal(await page.evaluate(() => window.stopped), true);
  // Cancelling discards the draft without any upload.
  await page.locator("#remark-cancel").click();
  assert.equal(await page.locator("#remark-sheet").isHidden(), true);
  assert.equal(await page.evaluate(() => window.savedRemark), undefined);

  await page.locator(".remark-add").first().click();         // first paragraph, via its own button
  await page.locator("#remark-stop").click();
  await page.locator("#remark-author").fill("Dan");
  await page.locator("#remark-save").click();
  await page.waitForSelector(".remark-chip");
  const saved = await page.evaluate(() => window.savedRemark);
  assert.match(saved.url, /\/api\/session\/cccccc\/remarks$/);
  assert.equal(saved.fields.sentence_index, "0");
  assert.equal(saved.fields.author, "Dan");
  assert.equal(saved.audioType, "audio/webm;codecs=opus");
  assert.equal(await page.locator("#remark-sheet").isHidden(), true);
  assert.match(await page.locator(".remark-row.has-remarks .remark-author").textContent(), /Dan/);

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".remark-del").click();
  await page.waitForFunction(() => document.querySelectorAll(".remark-chip").length === 0);
});

test("without microphone access the phone's own audio recorder is offered", async (t) => {
  const page = await setup(t, "?s=cccccc");
  await page.evaluate(() => Object.defineProperty(navigator, "mediaDevices", { value: undefined }));
  await openShared(page, twoParagraphs);
  await page.waitForSelector("#text-container .remark-row");
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".remark-add").nth(1).click();
  await (await chooser).setFiles({ name: "voce.m4a", mimeType: "audio/x-m4a", buffer: Buffer.from("m4a") });
  await page.waitForSelector("#remark-save", { state: "visible" });
  await page.locator("#remark-save").click();
  await page.waitForSelector(".remark-chip");
  assert.equal((await page.evaluate(() => window.savedRemark)).fields.sentence_index, "1");
});

test("one play/pause button and a speed button live in the bottom bar", async (t) => {
  const page = await setup(t, "?s=cccccc");
  await openShared(page, twoParagraphs);
  const bar = page.locator("#player-bar");
  assert.equal(await bar.locator("button").count(), 3);
  const box = await bar.boundingBox();
  assert.equal(Math.round(box.y + box.height), page.viewportSize().height);
  assert.equal(await page.locator("#play-btn").textContent(), "▶");
  await page.locator("#play-btn").click();
  assert.equal(await page.locator("#play-btn").textContent(), "⏸");
  assert.equal(await page.evaluate(() => window.testAudio.src), "/audio/cccccc/0.wav");
  await page.locator("#play-btn").click();
  assert.equal(await page.locator("#play-btn").textContent(), "▶");
  assert.equal(await page.evaluate(() => window.testAudio.paused), true);
  const speeds = [];
  for (let i = 0; i < 6; i++) {
    await page.locator("#speed-btn").click();
    speeds.push(await page.locator("#speed-btn").textContent());
  }
  assert.deepEqual(speeds, ["1.25x", "1.5x", "2x", "3x", "0.75x", "1x"]);
  assert.equal(await page.evaluate(() => window.testAudio.playbackRate), 1);
});

test("a shared link hides sharing and MP3; documents generated in this browser keep them", async (t) => {
  const page = await setup(t, "?s=eeeeee");
  await openShared(page, session("eeeeee"));
  assert.equal(await page.locator("#share-btn").isHidden(), true);
  assert.equal(await page.locator("#download-link").isHidden(), true);
  await submit(page, ["one.txt"]);
  await resolve(page, 1, "bbbbbb");
  await page.locator(".recent-document-row").filter({ hasText: "one.txt" }).getByRole("button", { name: "Deschide" }).click();
  await page.waitForFunction(() => document.querySelector("#text-container").textContent === "bbbbbb ");
  assert.equal(await page.locator("#share-btn").isVisible(), true);
  assert.equal(await page.locator("#download-link").isVisible(), true);
  // Going back to the shared document hides them again.
  await page.evaluate(() => { window.sessionResponses["/api/session/eeeeee"] = { session_id: "eeeeee", sentences: [{ index: 0, text: "eeeeee", duration: 1, audio_url: "/e.wav" }], blocks: [{ type: "paragraph", sentence_indices: [0] }], mp3_url: "/e.mp3" }; });
  await page.locator(".recent-document-row").filter({ hasText: "Document partajat" }).getByRole("button", { name: "Deschide" }).click();
  await page.waitForFunction(() => document.querySelector("#text-container").textContent === "eeeeee ");
  assert.equal(await page.locator("#share-btn").isHidden(), true);
});

// Every visible piece of text must be readable against what is really behind it.
async function unreadableText(page) {
  // Colours are measured mid-transition otherwise.
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  return page.evaluate(() => {
    const parse = (value) => (value.match(/[\d.]+/g) || []).map(Number);
    const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const over = (top, bottom) => {
      const alpha = top[3] ?? 1;
      return [0, 1, 2].map((i) => top[i] * alpha + bottom[i] * (1 - alpha));
    };
    const failures = [];
    for (const el of document.body.querySelectorAll("*")) {
      const own = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (!own || !rect.width || !rect.height || style.visibility === "hidden" || el.closest("[hidden]")) continue;
      const color = parse(style.color);
      if (color.length === 4 && color[3] === 0) continue;       // transparent clipped gradient title
      let opacity = 1;
      const layers = [];
      for (let node = el; node; node = node.parentElement) {
        const cs = getComputedStyle(node);
        opacity *= Number(cs.opacity);
        const bg = parse(cs.backgroundColor);
        if (bg.length && (bg[3] ?? 1) > 0) layers.unshift(bg);
      }
      let background = [255, 255, 255];
      for (const layer of layers) background = over(layer, background);
      const foreground = over([...color.slice(0, 3), (color[3] ?? 1) * opacity], background);
      const [a, b] = [luminance(foreground), luminance(background)];
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < 4.5) failures.push(`${el.id || el.className || el.tagName} "${el.textContent.trim().slice(0, 20)}" ${ratio.toFixed(2)}`);
    }
    return failures;
  });
}

test("no text is white-on-white or otherwise unreadable in any state", async (t) => {
  const page = await setup(t, "?s=cccccc");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    window.remarkItems = [{ id: "r1", sentence_index: 1, audio_url: "/a.webm", duration: 12, author: "Ana" }];
    window.stopped = false;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    } });
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { this.state = "inactive"; this.mimeType = "audio/webm"; this.handlers = {}; }
      addEventListener(type, handler) { this.handlers[type] = handler; }
      start() { this.state = "recording"; }
      stop() { this.state = "inactive"; this.handlers.dataavailable({ data: new Blob(["v"]) }); this.handlers.stop(); }
    };
  });
  const styled = { ...twoParagraphs, sentences: twoParagraphs.sentences.map((sentence, index) => index === 0 ?
    { ...sentence, runs: [{ t: "Primul ", hl: "#ffff00" }, { t: "paragraf ", hl: "#000080" }, { t: "are o singură propoziție.", hl: "#00ff00", b: true }] } : sentence) };
  await openShared(page, styled);
  await page.waitForSelector(".remark-chip");
  assert.deepEqual(await unreadableText(page), [], "player at rest");

  await page.locator('[data-index="0"] .word').first().click();      // playing: active sentence and word
  await page.evaluate(() => { window.testAudio.currentTime = 0.5; window.testAudio.listeners.timeupdate(); });
  assert.deepEqual(await unreadableText(page), [], "while playing");
  await page.locator("#play-btn").click();
  assert.equal(await page.locator("#next-page").isDisabled(), true);
  assert.deepEqual(await unreadableText(page), [], "disabled controls");

  for (const button of await page.locator("button:visible").all()) {   // hover/focus colours stick on phones
    await button.hover();
    assert.deepEqual(await unreadableText(page), [], `hover ${await button.evaluate((el) => el.id || el.className)}`);
  }
  await page.mouse.move(0, 0);

  await page.locator(".remark-play").click();
  assert.deepEqual(await unreadableText(page), [], "remark playing");
  await page.locator("#remark-dock-btn").click();
  await page.waitForSelector("#remark-stop", { state: "visible" });
  assert.deepEqual(await unreadableText(page), [], "recording sheet");
  await page.locator("#remark-stop").click();
  await page.waitForSelector("#remark-save", { state: "visible" });
  assert.deepEqual(await unreadableText(page), [], "review sheet");
  await page.locator("#remark-cancel").click();
  assert.deepEqual(await unreadableText(page), [], "recent document row");
  await page.locator(".recent-document-row").getByRole("button", { name: "Șterge" }).click();
  assert.deepEqual(await unreadableText(page), [], "delete confirmation");
});
