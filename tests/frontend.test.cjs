const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "frontend/index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "frontend/script.js"), "utf8");

async function setup(t, query = "") {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("http://test/**", (route) => route.fulfill({
    contentType: "text/html", body: html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "")
  }));
  await page.goto(`http://test/${query}`);
  await page.evaluate(() => {
    window.pendingRequests = [];
    window.sessionResponses = {};
    window.fetch = (url, options = {}) => {
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
