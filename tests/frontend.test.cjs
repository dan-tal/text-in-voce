const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "frontend/index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "frontend/script.js"), "utf8");

async function setup(t, query = "") {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("http://test/**", (route) => {
    const mainPage = new URL(route.request().url()).pathname === "/";
    return route.fulfill({
      contentType: mainPage ? "text/html" : "text/plain",
      body: mainPage ? html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "") : "",
    });
  });
  await page.goto(`http://test/${query}`);
  await page.evaluate(() => {
    window.pendingRequests = [];
    window.fetch = (url, options) => new Promise((resolve) => {
      window.pendingRequests.push({ url, name: options?.body.get("file").name, resolve });
    });
    window.Audio = class {
      currentTime = 0;
      duration = 1;
      listeners = {};
      constructor() { window.testAudio = this; }
      addEventListener(type, handler) { this.listeners[type] = handler; }
      pause() { this.paused = true; }
      play() { return Promise.resolve(); }
    };
  });
  await page.addScriptTag({ content: script });
  return page;
}

async function submit(page, names) {
  await page.locator("#file-input").setInputFiles(names.map((name) => ({
    name, mimeType: "text/plain", buffer: Buffer.from("Salut."),
  })));
  await page.locator("#upload-btn").click();
}

async function resolveRequest(page, index, name, error = false) {
  await page.evaluate(({ index, name, error }) => {
    const data = {
      session_id: name,
      sentences: [{ index: 0, text: name, duration: 1, audio_url: `/audio/${name}/0.wav` }],
      blocks: [{ type: "paragraph", sentence_indices: [0] }],
      mp3_url: `/audio/${name}/full.mp3`,
    };
    window.pendingRequests[index].resolve({
      ok: !error, status: error ? 429 : 200,
      json: async () => error ? { detail: "Coada este plină" } : data,
    });
  }, { index, name, error });
}

test("multiple documents queue, finish out of order and open independently", async (t) => {
  const page = await setup(t);
  await submit(page, ["one.txt", "two.txt", "three.txt"]);
  assert.equal(await page.evaluate(() => window.pendingRequests.length), 2);
  assert.equal(await page.locator(".document-row").count(), 3);
  assert.match(await page.locator("#status").textContent(), /2 în curs · 1 în așteptare/);
  await submit(page, ["four.txt"]);
  assert.equal(await page.evaluate(() => window.pendingRequests.length), 2);

  await resolveRequest(page, 1, "bbbbbb");
  await page.waitForFunction(() => window.pendingRequests.length === 3);
  assert.equal(await page.locator("#text-container").textContent(), "bbbbbb ");
  await resolveRequest(page, 0, "aaaaaa");
  await page.waitForFunction(() => window.pendingRequests.length === 4);
  assert.equal(await page.locator("#text-container").textContent(), "bbbbbb ");
  await page.locator(".document-row").nth(0).getByRole("button", { name: "Deschide" }).click();
  assert.equal(await page.locator("#text-container").textContent(), "aaaaaa ");
  assert.match(page.url(), /s=aaaaaa/);
  assert.equal(await page.locator("#download-link").getAttribute("href"), "/audio/aaaaaa/full.mp3");
  await resolveRequest(page, 2, "cccccc");
  await resolveRequest(page, 3, "dddddd");
  await page.waitForFunction(() => document.querySelector("#status").textContent === "4 gata · 0 în curs · 0 în așteptare");
  assert.equal(await page.locator("#text-container").textContent(), "aaaaaa ");
});

test("a failed document can be retried without losing successful results", async (t) => {
  const page = await setup(t);
  await submit(page, ["one.txt", "two.txt", "three.txt"]);
  await resolveRequest(page, 0, "aaaaaa", true);
  await page.waitForFunction(() => window.pendingRequests.length === 3);
  assert.match(await page.locator(".document-row").nth(0).textContent(), /Coada este plină/);
  await page.getByRole("button", { name: "Reîncearcă" }).click();
  assert.equal(await page.evaluate(() => window.pendingRequests.length), 3);
  await resolveRequest(page, 1, "bbbbbb");
  await page.waitForFunction(() => window.pendingRequests.length === 4);
  assert.equal(await page.evaluate(() => window.pendingRequests[3].name), "one.txt");
  await resolveRequest(page, 2, "cccccc");
  await resolveRequest(page, 3, "aaaaaa");
  await page.waitForFunction(() => document.querySelector("#status").textContent === "3 gata · 0 în curs · 0 în așteptare");
  assert.equal(await page.locator(".document-row.failed").count(), 0);
  assert.equal(await page.locator("#text-container").textContent(), "bbbbbb ");
});

test("a late shared-session response does not replace the user's selected document", async (t) => {
  const page = await setup(t, "?s=eeeeee");
  assert.equal(await page.evaluate(() => window.pendingRequests[0].url), "/api/session/eeeeee");
  await submit(page, ["one.txt"]);
  await resolveRequest(page, 1, "aaaaaa");
  await page.waitForFunction(() => document.querySelector("#text-container").textContent === "aaaaaa ");
  await resolveRequest(page, 0, "eeeeee");
  assert.equal(await page.locator("#text-container").textContent(), "aaaaaa ");
  assert.match(page.url(), /s=aaaaaa/);
});

test("a shared session still opens directly", async (t) => {
  const page = await setup(t, "?s=eeeeee");
  await resolveRequest(page, 0, "eeeeee");
  await page.waitForFunction(() => document.querySelector("#text-container").textContent === "eeeeee ");
  assert.equal(await page.locator(".document-row.selected").count(), 1);
  assert.equal(await page.locator("#player-section").isVisible(), true);
});

async function loadSession(page, data) {
  await page.evaluate((data) => {
    window.pendingRequests[0].resolve({ ok: true, json: async () => data });
  }, data);
  await page.waitForFunction(() => !document.querySelector("#player-section").hidden);
}

function pdfSession() {
  return {
    session_id: "aaaaaa", page_count: 4, original_url: "/audio/aaaaaa/original.pdf",
    sentences: [
      { index: 0, text: "Titlu marcat.", page: 1, duration: 1, audio_url: "/one.wav", runs: [{ t: "Titlu ", b: true }, { t: "marcat.", hl: "#ffff00", i: true }] },
      { index: 1, text: "Pagina trei.", page: 3, duration: 1, audio_url: "/three.wav" },
    ],
    blocks: [{ type: "heading", level: 2, sentence_indices: [0] }, { type: "paragraph", sentence_indices: [1] }],
  };
}

test("PDF next, previous and manual page numbers include blank pages and preserve formatting", async (t) => {
  const page = await setup(t, "?s=aaaaaa");
  await loadSession(page, pdfSession());
  assert.equal(await page.locator("#page-count").textContent(), "/ 4");
  assert.equal(await page.locator("#prev-page").isEnabled(), false);
  assert.equal(await page.locator(".word.b").textContent(), "Titlu");
  assert.equal(await page.locator(".word.hl.i").textContent(), "marcat.");
  assert.equal(await page.locator("#original-frame").getAttribute("src"), "/audio/aaaaaa/original.pdf#page=1");
  await page.locator("#next-page").click();
  assert.match(await page.locator("#text-container").textContent(), /nu conține text/);
  assert.equal(await page.locator("#play-btn").isEnabled(), false);
  assert.equal(await page.locator("#original-frame").getAttribute("src"), "/audio/aaaaaa/original.pdf#page=2");
  await page.locator("#page-input").fill("3");
  await page.locator("#page-input").press("Enter");
  assert.equal(await page.locator("#text-container").textContent(), "Pagina trei. ");
  assert.match(page.url(), /p=3/);
  await page.locator("#play-btn").click();
  assert.equal(await page.evaluate(() => window.testAudio.src), "/three.wav");
  await page.locator("#next-page").click();
  assert.equal(await page.locator("#next-page").isEnabled(), false);
  assert.equal(await page.locator("#pause-btn").isEnabled(), false);
  await page.locator("#prev-page").click();
  assert.equal(await page.locator("#page-input").inputValue(), "3");
  await page.locator("#page-input").fill("99");
  await page.locator("#page-form button").click();
  assert.equal(await page.locator("#text-container").textContent(), "Pagina trei. ");
  assert.equal(await page.locator("#page-input").evaluate((input) => input.validity.rangeOverflow), true);
});

test("audio follows source pages automatically and skips blank pages", async (t) => {
  const page = await setup(t, "?s=aaaaaa");
  await loadSession(page, pdfSession());
  await page.locator("#play-btn").click();
  await page.evaluate(() => window.testAudio.listeners.ended());
  assert.equal(await page.locator("#page-input").inputValue(), "3");
  assert.equal(await page.locator("#original-frame").getAttribute("src"), "/audio/aaaaaa/original.pdf#page=3");
  assert.equal(await page.locator(".sentence.active").textContent(), "Pagina trei. ");
  assert.equal(await page.evaluate(() => window.testAudio.src), "/three.wav");
});

test("reader pages render only the chosen page and shared links restore that page", async (t) => {
  const page = await setup(t, "?s=aaaaaa&p=3");
  const data = {
    session_id: "aaaaaa",
    sentences: Array.from({ length: 4 }, (_, index) => ({ index, text: `${index}: ` + "cuvânt ".repeat(230), duration: 1, audio_url: `/${index}.wav` })),
    blocks: [{ type: "paragraph", sentence_indices: [0, 1, 2, 3] }],
  };
  await loadSession(page, data);
  assert.equal(await page.locator("#page-input").inputValue(), "3");
  assert.equal(await page.locator("#page-count").textContent(), "/ 4");
  assert.equal(await page.locator(".sentence").count(), 1);
  assert.match(await page.locator("#text-container").textContent(), /^2:/);
  await page.locator("#prev-page").click();
  assert.match(await page.locator("#text-container").textContent(), /^1:/);
  assert.equal(await page.locator("#page-kind").textContent(), "Pagini de lectură");
});

test("pasted text uses the same queue while document uploads are running", async (t) => {
  const page = await setup(t);
  await submit(page, ["one.txt", "two.txt"]);
  await page.locator("#paste-btn").click();
  await page.locator("#paste-text").fill("Text din clipboard.");
  await page.locator("#paste-submit").click();
  assert.equal(await page.locator(".document-row").count(), 3);
  assert.equal(await page.evaluate(() => window.pendingRequests.length), 2);
  await resolveRequest(page, 0, "aaaaaa");
  await page.waitForFunction(() => window.pendingRequests.length === 3);
  assert.equal(await page.evaluate(() => window.pendingRequests[2].name), "text-lipit.txt");
});

test("audio errors allow retry and page changes ignore interrupted play requests", async (t) => {
  const page = await setup(t, "?s=aaaaaa");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await loadSession(page, pdfSession());
  await page.evaluate(() => {
    window.testAudio.play = () => Promise.reject(new DOMException("Failed", "NotSupportedError"));
  });
  await page.locator("#play-btn").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("Nu s-a putut reda audio"));
  assert.equal(await page.locator("#play-btn").isEnabled(), true);
  await page.evaluate(() => {
    window.testAudio.play = () => new Promise((resolve, reject) => { window.rejectPlay = reject; });
  });
  await page.locator("#play-btn").click();
  await page.locator("#next-page").click();
  await page.evaluate(() => window.rejectPlay(new DOMException("Interrupted", "AbortError")));
  assert.equal(await page.locator("#play-btn").isEnabled(), false);
  assert.deepEqual(errors, []);
});
