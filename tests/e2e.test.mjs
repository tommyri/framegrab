// Drives the real extension in Chromium against local fixture pages and checks
// the pixels of the resulting images.
//
// The test copy of the extension gets <all_urls>, because automation can't press
// the toolbar button that grants activeTab. shipping-manifest.test.mjs covers that.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCALE = 2;
let VIEWPORT = { width: 0, height: 0 };
const BAND = 500;
const COLORS = ["#2040c0", "#20a060", "#a06020", "#8020a0", "#209090", "#606060"];

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const bands = (count) =>
  Array.from({ length: count }, (_, i) =>
    `<div style="height:${BAND}px;background:${COLORS[i % COLORS.length]}"></div>`).join("");
const doc = (body, head = "") =>
  `<!doctype html><html><head><style>html,body{margin:0}${head}</style></head><body>${body}</body></html>`;

const lineStyle = "margin:0 0 10px;height:40px;width:760px;background:#fff;color:#ff0000;font:30px monospace;white-space:nowrap";
function partial(text) {
  return doc(`<p id="line" style="${lineStyle}">${text}</p><script>window.pageClicks = 0; addEventListener("click", () => window.pageClicks++);</script>`);
}

const PAGES = {
  "/tall": doc(`
    <div id="top" style="position:fixed;top:0;left:0;right:0;height:60px;background:#ff0000;z-index:9"></div>
    <div id="widget" style="position:fixed;bottom:10px;right:10px;width:50px;height:50px;background:#00ff00;z-index:9"></div>
    ${bands(12)}`, "html{scroll-behavior:smooth}"),
  "/sticky": doc(`
    ${bands(2)}
    <div id="stick" style="position:sticky;top:0;height:40px;background:#ffff00"></div>
    ${bands(6)}`),
  "/element": doc(`
    <div style="height:2000px"></div>
    <div id="card" style="width:300px;height:200px;margin-left:100px;background:#123456">
      <span id="inner" style="display:block;width:100px;height:50px;background:#fedcba"></span>
    </div>
    <div style="height:2000px"></div>
    <script>
      window.pageClicks = 0;
      addEventListener("click", () => window.pageClicks++);
      document.getElementById("card").addEventListener("click", () => window.pageClicks++);
    </script>`),
  "/tall-element": doc(`
    <div style="position:fixed;top:0;left:0;right:0;height:60px;background:#ff0000;z-index:9"></div>
    <div style="height:300px;background:#000"></div>
    <div id="long" style="width:800px;margin-left:50px">${bands(5)}</div>
    <div style="height:800px;background:#000"></div>`),
  "/panel": doc(`
    <div style="height:100vh;display:flex;overflow:hidden">
      <nav style="width:200px;background:#ff0000"></nav>
      <main id="panel" style="flex:1;overflow:auto">${bands(6)}</main>
    </div>`),
  "/nested": doc(`
    <div style="height:100px;background:#000"></div>
    <div id="scroll" style="height:400px;width:600px;overflow:auto">
      <div style="height:200px"></div>
      <div id="deep" style="height:1500px">${bands(3)}</div>
    </div>
    <div style="height:2000px"></div>`),
  "/partial-strict": doc(`<p id="line" style="margin:0;height:40px;width:760px;color:#ff0000;font:30px monospace">before SECRETTOKEN after</p>`),
  "/blur-strict": doc(`<p id="one" style="margin:0;width:300px;height:40px;color:#ff0000;font:30px monospace">SECRET</p>`),
  "/strict": doc(`<div id="card" style="width:200px;height:100px;background:#123456"></div>${bands(3)}`),
  "/dialog": doc(`
    ${bands(2)}
    <dialog id="dlg" style="padding:0;border:0"><div id="inside" style="width:240px;height:120px;background:#123456"></div></dialog>
    <script>document.getElementById("dlg").showModal()</script>`),
  "/short": doc(`<div id="card" style="height:100px;background:#123456"></div>`),
};

// Same structure on both, so the element has to be found by position.
const compareBody = (color, extra = "") => doc(`
  ${extra}
  <section><div></div><div style="width:400px;height:150px;background:${color}"></div></section>
  <div style="height:300px"></div>`);
Object.assign(PAGES, {
  "/compare-a": compareBody("#123456"),
  "/compare-b": compareBody("#fedcba"),
  "/compare-narrow": doc(`<div id="tall" style="width:100px;height:300px;background:#123456"></div>`),
  "/compare-page": doc(bands(2)),
  "/compare-gone": doc(`<p id="other" style="height:50px;width:300px;background:#00ff00"></p>`),
  "/compare-shadow": doc(`
    <div id="wc"></div>
    <script>
      const root = document.getElementById("wc").attachShadow({ mode: "open" });
      const b = document.createElement("div");
      b.setAttribute("data-testid", "inside");
      b.style.cssText = "width:120px;height:60px;background:#123456";
      root.append(b);
    </script>`),
});

const secret = (id, text) =>
  `<p id="${id}" style="margin:0 0 10px;width:300px;height:40px;background:#fff;color:#ff0000;font:30px monospace">${text}</p>`;
Object.assign(PAGES, {
  "/blur": doc(`
    ${secret("one", "TOKEN123")}
    ${secret("two", "OTHERVAL")}
    <div><span id="inline" style="color:#ff0000;font:30px monospace">inline</span></div>
    <input id="field" value="hunter2" style="display:block;width:300px;height:40px;color:#ff0000;background:#ff0000">
    <canvas id="art" width="300" height="40" style="display:block;margin-top:10px"></canvas>
    <p id="spill" style="margin:10px 0;width:60px;height:40px;white-space:nowrap;color:#ff0000;font:30px monospace">overflowing text</p>
    <script>
      const c = document.getElementById("art").getContext("2d");
      c.fillStyle = "#ff0000"; c.fillRect(0, 0, 300, 40);
      window.pageClicks = 0;
      addEventListener("click", () => window.pageClicks++);
    </script>`),
  "/blur-tall": doc(`${bands(3)}${secret("deep", "TOKEN123")}${bands(3)}`),
  "/annotate": doc(`<div style="height:3000px;background:#123456"></div>`, "body{background:#123456}"),
  "/blur-other": doc(`${secret("unrelated", "NOTSECRET")}`),
  "/partial": partial("before SECRETTOKEN after", "SECRETTOKEN"),
  "/partial-shifted": partial("added text before SECRETTOKEN after", "SECRETTOKEN"),
  "/partial-changed": partial("before DIFFERENT00 after", "DIFFERENT00"),
  "/partial-twin": doc(`<p id="a" style="${lineStyle}">before SECRETTOKEN after</p><p id="b" style="${lineStyle}">before OTHERVALUES after</p>`),
  "/partial-tall": doc(`
    <div style="position:fixed;top:0;left:0;right:0;height:50px;background:#00ff00;z-index:9"><span id="head" style="${lineStyle};display:inline">head SECRET</span></div>
    ${bands(3)}<p id="line" style="${lineStyle}">before SECRETTOKEN after</p>${bands(3)}`),
  "/partial-panel": doc(`
    <div id="panel" style="height:200px;width:700px;overflow:auto;background:#fff"><p id="line" style="${lineStyle}">before SECRETTOKEN after</p><div style="height:2000px"></div></div>
    <div id="below" style="height:300px;background:#00ff00"></div>`),
  "/partial-shadow": doc(`
    <div id="wc"></div>
    <script>
      const root = document.getElementById("wc").attachShadow({ mode: "open" });
      const p = document.createElement("p");
      p.id = "line";
      p.style.cssText = ${JSON.stringify(lineStyle)};
      p.textContent = "before SECRETTOKEN after";
      root.append(p);
      window.shadowText = root;
    </script>`),
  "/partial-hidden-parent": doc(`<p id="line" style="${lineStyle};visibility:hidden">before <span style="visibility:visible">SECRET</span><span style="visibility:visible">TOKEN</span> after</p>`),
  "/partial-escaped": doc(`
    <div style="overflow:hidden;width:150px;height:40px">
      <p id="line" style="margin:0;color:#ff0000;font:30px monospace;white-space:nowrap">
        <span style="position:absolute;left:300px;top:100px;background:#fff">SECRET</span><span style="position:absolute;left:408px;top:100px;background:#fff">TOKEN</span>
      </p>
    </div>`),
  "/partial-spans": doc(`<p id="line" style="${lineStyle}">before <b>SECRET</b>TOKEN after</p>`),
  "/blur-hide-svg": doc(`${secret("one", "TOKEN123")}`, "svg{display:none!important}"),
  "/blur-popover-shadow": doc(`
    <div id="holder" style="width:300px;height:60px"><div id="wc"></div></div>
    <script>
      const root = document.getElementById("wc").attachShadow({ mode: "open" });
      const pop = document.createElement("div");
      pop.id = "pop";
      pop.popover = "manual";
      pop.textContent = "SECRET";
      pop.style.cssText = "width:200px;height:50px;background:#ff0000;margin:0;inset:auto;top:200px;left:20px";
      root.append(pop);
      window.openPop = () => pop.showPopover();
    </script>`),
  "/blur-popover": doc(`
    <div id="holder" style="width:300px;height:60px">
      <div id="pop" popover="manual" style="width:200px;height:50px;background:#ff0000;margin:0;inset:auto;top:200px;left:20px">SECRET</div>
    </div>`),
  "/blur-b": doc(`${secret("one", "TOKEN123")}${secret("two", "CHANGED")}`),
  "/blur-shadow": doc(`
    <div id="wc"></div>
    <script>
      const root = document.getElementById("wc").attachShadow({ mode: "open" });
      const p = document.createElement("p");
      p.id = "inshadow";
      p.textContent = "SECRET";
      p.style.cssText = "margin:0;width:300px;height:40px;color:#ff0000;font:30px monospace";
      root.append(p);
    </script>`),
  "/blur-base": doc(`${secret("one", "TOKEN123")}`, "").replace("<head>", '<head><base href="https://example.invalid/somewhere/">'),
});

const STRICT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; require-trusted-types-for 'script'";

let server, baseUrl, context, worker, extensionDir, profileDir, page;

before(async () => {
  server = createServer((req, res) => {
    const html = PAGES[req.url];
    if (!html) return res.writeHead(404).end();
    const headers = { "content-type": "text/html" };
    if (req.url === "/strict" || req.url === "/blur-strict" || req.url === "/partial-strict") headers["content-security-policy"] = STRICT_CSP;
    res.writeHead(200, headers).end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  extensionDir = mkdtempSync(join(tmpdir(), "framegrab-ext-"));
  cpSync(join(ROOT, "extension"), extensionDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  // Only so tests can read back what the editor copied.
  manifest.permissions.push("clipboardRead");
  writeFileSync(join(extensionDir, "manifest.json"), JSON.stringify(manifest));
  // Playwright can't see into closed shadow roots, so the test copy opens them.
  // shipping-manifest.test.mjs checks that the real one stays closed.
  const contentFile = join(extensionDir, "content.js");
  const content = readFileSync(contentFile, "utf8");
  const opened = content.replace('attachShadow({ mode: "closed" })', 'attachShadow({ mode: "open" })');
  assert.notEqual(opened, content, "content.js should create a closed shadow root");
  writeFileSync(contentFile, opened);

  profileDir = mkdtempSync(join(tmpdir(), "framegrab-profile-"));
  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    // A real device scale, as on a Retina screen. Playwright's emulated one
    // doesn't reach captureVisibleTab.
    viewport: null,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      `--force-device-scale-factor=${SCALE}`,
      "--window-size=1000,800",
    ],
  });
  [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker");
});

after(async () => {
  await context?.close();
  server?.close();
  rmSync(extensionDir, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await worker.evaluate(() => chrome.storage.local.set({ size: "full" }));
  await worker.evaluate(() => chrome.storage.session.clear());
  await worker.evaluate(() => chrome.action.setBadgeText({ text: "" }));
  await worker.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("framegrab", 2);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("captures", { keyPath: "id" });
        req.result.createObjectStore("before", { keyPath: "slot" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("before", "readwrite");
    tx.objectStore("before").clear();
    await new Promise((resolve) => (tx.oncomplete = resolve));
    db.close();
  });
});

async function open(path) {
  page = await context.newPage();
  await page.goto(baseUrl + path);
  await page.bringToFront();
  VIEWPORT = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  return page;
}

// Same two steps the service worker's start() performs.
async function start(mode) {
  await worker.evaluate(async ({ mode }) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "framegrab-start", mode });
  }, { mode });
}

const toast = () => page.locator("framegrab-ui .toast");

async function latestId() {
  return worker.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("framegrab", 2);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const keys = await new Promise((resolve) => {
      const req = db.transaction("captures").objectStore("captures").getAllKeys();
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    return keys.at(-1) ?? null;
  });
}

// Reads the newest capture. `columns` are returned top to bottom in image pixels.
async function readCapture(columns = [], regions = []) {
  await toast().waitFor({ timeout: 60000 });
  return worker.evaluate(async ({ columns, regions }) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("framegrab", 2);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const all = await new Promise((resolve) => {
      const req = db.transaction("captures").objectStore("captures").getAll();
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    const capture = all.at(-1);
    const bitmap = await createImageBitmap(capture.blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const digest = await crypto.subtle.digest("SHA-256", pixels);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    let red = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 230 && pixels[i + 1] < 40 && pixels[i + 2] < 40) red++;
    }
    const regionsOut = [];
    for (const [x, y, w, h] of regions) {
      const data = ctx.getImageData(x, y, w, h).data;
      let regionRed = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 230 && data[i + 1] < 40 && data[i + 2] < 40) regionRed++;
      }
      const sum = await crypto.subtle.digest("SHA-256", data);
      regionsOut.push({
        red: regionRed,
        hash: [...new Uint8Array(sum)].map((b) => b.toString(16).padStart(2, "0")).join(""),
      });
    }
    const output = {};
    for (const x of columns) {
      const data = ctx.getImageData(x, 0, 1, bitmap.height).data;
      output[x] = Array.from({ length: bitmap.height }, (_, y) => [data[y * 4], data[y * 4 + 1], data[y * 4 + 2]]);
    }
    return {
      id: capture.id,
      compare: capture.compare,
      hash,
      red,
      regions: regionsOut,
      width: bitmap.width,
      height: bitmap.height,
      filename: capture.filename,
      notes: capture.notes,
      columns: output,
    };
  }, { columns, regions });
}

const near = (a, b, tolerance = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

function assertBands(column, { from = 0, offset = 0, scale = SCALE }) {
  for (let y = from; y < column.length; y++) {
    const cssY = (y + offset) / scale;
    const edge = Math.abs(cssY % BAND) < 1 || BAND - cssY % BAND < 1;
    if (edge) continue;
    const expected = rgb(COLORS[Math.floor(cssY / BAND) % COLORS.length]);
    assert.ok(near(column[y], expected), `image y=${y}: got ${column[y]}, expected ${expected}`);
  }
}

test("visible area matches the viewport", async () => {
  await open("/tall");
  await start("visible");
  const shot = await readCapture([500]);
  assert.equal(shot.width, VIEWPORT.width * SCALE);
  assert.equal(shot.height, VIEWPORT.height * SCALE);
  assert.deepEqual(shot.columns[500][10], [255, 0, 0]);
  await page.close();
});

test("full page stitches without seams, repeats or stray overlays", async () => {
  await open("/tall");
  await page.evaluate(() => window.scrollTo({ top: 1234, behavior: "instant" }));
  await start("full");
  const rightEdge = VIEWPORT.width * SCALE - 40;
  const shot = await readCapture([500, rightEdge]);
  assert.equal(shot.height, 6000 * SCALE);
  assert.equal(shot.width, VIEWPORT.width * SCALE);

  const middle = shot.columns[500];
  assert.deepEqual(middle[10], [255, 0, 0], "top bar stays at the top of the image");
  assertBands(middle, { from: 60 * SCALE });

  const right = shot.columns[rightEdge];
  assert.ok(!right.some((px) => near(px, [0, 255, 0])), "bottom widget must not appear");

  const state = await page.evaluate(() => ({
    y: window.scrollY,
    top: document.getElementById("top").style.visibility,
    widget: document.getElementById("widget").style.visibility,
  }));
  assert.deepEqual(state, { y: 1234, top: "", widget: "" });
  await page.close();
});

test("sticky elements appear once, in their natural position", async () => {
  await open("/sticky");
  await start("full");
  const shot = await readCapture([500]);
  const yellow = shot.columns[500].filter((px) => near(px, [255, 255, 0])).length;
  assert.equal(yellow, 40 * SCALE);
  assert.ok(near(shot.columns[500][1000 * SCALE + 4], [255, 255, 0]));
  assert.equal(await page.evaluate(() => document.getElementById("stick").style.position), "sticky");
  await page.close();
});

test("full page on an app-shell layout captures the scrolling panel", async () => {
  await open("/panel");
  await start("full");
  const shot = await readCapture([400]);
  assert.equal(shot.width, (VIEWPORT.width - 200) * SCALE);
  assert.equal(shot.height, 3000 * SCALE);
  assertBands(shot.columns[400], {});
  assert.deepEqual(shot.notes, ["Captured the page's scrolling panel."]);
  await page.close();
});

test("picker: click captures the element and never reaches the page", async () => {
  await open("/element");
  await page.evaluate(() => window.scrollTo({ top: 1800, behavior: "instant" }));
  await start("element");
  await page.locator("framegrab-ui .hint").waitFor();
  await page.mouse.move(350, 350);
  await page.locator("framegrab-ui .box").waitFor();
  await page.mouse.click(350, 350);
  const shot = await readCapture([500]);
  assert.equal(shot.width, 300 * SCALE);
  assert.equal(shot.height, 200 * SCALE);
  assert.ok(shot.columns[500].every((px) => near(px, rgb("#123456"))));
  assert.equal(await page.evaluate(() => window.pageClicks), 0);
  assert.equal(await page.evaluate(() => window.scrollY), 1800);
  assert.match(shot.filename, /^Framegrab\/localhost_card_\d{4}-\d{2}-\d{2}_\d{6}\.png$/);
  await page.close();
});

test("picker: arrow keys walk the tree and Enter captures", async () => {
  await open("/element");
  await page.evaluate(() => window.scrollTo({ top: 1800, behavior: "instant" }));
  await start("element");
  await page.locator("framegrab-ui .hint").waitFor();
  await page.mouse.move(130, 220);
  const tag = page.locator("framegrab-ui .tag");
  await tag.waitFor();
  assert.match(await tag.textContent(), /^span#inner\s+100 × 50$/);
  await page.keyboard.press("ArrowUp");
  assert.match(await tag.textContent(), /^div#card/);
  await page.keyboard.press("ArrowDown");
  assert.match(await tag.textContent(), /^span#inner/);
  await page.keyboard.press("Enter");
  const shot = await readCapture();
  assert.equal(shot.width, 100 * SCALE);
  assert.equal(shot.height, 50 * SCALE);
  await page.close();
});

test("picker: Escape cancels without capturing", async () => {
  await open("/element");
  const before = await latestId();
  await start("element");
  await page.locator("framegrab-ui .hint").waitFor();
  await page.locator("framegrab-ui .hint").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("framegrab-ui").waitFor({ state: "detached" });
  await page.waitForTimeout(300);
  assert.equal(await latestId(), before);
  await page.close();
});

test("element taller than the window is stitched", async () => {
  await open("/tall-element");
  await start("element");
  await page.locator("framegrab-ui .hint").waitFor();
  await page.mouse.move(400, 400);
  await page.locator("framegrab-ui .tag").waitFor();
  const tag = page.locator("framegrab-ui .tag");
  // The pointer lands on a band; its parent is the tall element.
  await page.keyboard.press("ArrowUp");
  assert.match(await tag.textContent(), /^div#long/);
  await page.keyboard.press("Enter");
  const shot = await readCapture([400]);
  assert.equal(shot.width, 800 * SCALE);
  assert.equal(shot.height, 2500 * SCALE);
  assertBands(shot.columns[400], {});
  assert.ok(!shot.columns[400].some((px) => near(px, [255, 0, 0])), "fixed bar must not cover the element");
  await page.close();
});

test("element inside a nested scroll container is stitched and restored", async () => {
  await open("/nested");
  await start("element");
  await page.locator("framegrab-ui .hint").waitFor();
  await page.mouse.move(300, 350);
  await page.locator("framegrab-ui .tag").waitFor();
  await page.keyboard.press("ArrowUp");
  const tag = page.locator("framegrab-ui .tag");
  assert.match(await tag.textContent(), /^div#deep/);
  await page.keyboard.press("Enter");
  const shot = await readCapture([100]);
  assert.equal(shot.height, 1500 * SCALE);
  assertBands(shot.columns[100], {});
  assert.equal(await page.evaluate(() => document.getElementById("scroll").scrollTop), 0);
  await page.close();
});

test("works on a page with a strict CSP and Trusted Types", async () => {
  await open("/strict");
  await start("element");
  await page.locator("framegrab-ui .hint").waitFor();
  await page.mouse.move(100, 50);
  await page.locator("framegrab-ui .box").waitFor();
  const styled = await page.locator("framegrab-ui .tag").evaluate((el) => getComputedStyle(el).position);
  assert.equal(styled, "fixed");
  await page.mouse.click(100, 50);
  const shot = await readCapture();
  assert.equal(shot.width, 200 * SCALE);
  assert.equal(shot.height, 100 * SCALE);
  await page.close();
});

test("picker reaches elements inside a modal dialog", async () => {
  await open("/dialog");
  await start("element");
  await page.locator("framegrab-ui .hint").waitFor();
  const box = await page.locator("#inside").boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  const tag = page.locator("framegrab-ui .tag");
  await tag.waitFor();
  assert.match(await tag.textContent(), /^div#inside/);
  await page.mouse.click(box.x + 20, box.y + 20);
  const shot = await readCapture();
  assert.equal(shot.width, 240 * SCALE);
  assert.equal(shot.height, 120 * SCALE);
  await page.close();
});

test("standard size produces a 1x image", async () => {
  await worker.evaluate(() => chrome.storage.local.set({ size: "1x" }));
  await open("/tall");
  await start("full");
  const shot = await readCapture([500]);
  assert.equal(shot.width, VIEWPORT.width);
  assert.equal(shot.height, 6000);
  assertBands(shot.columns[500], { from: 60, scale: 1 });
  await page.close();
});

test("toast does not block clicks on the page", async () => {
  await open("/element");
  await start("visible");
  await toast().waitFor({ timeout: 30000 });
  await page.mouse.click(50, 650);
  assert.equal(await page.evaluate(() => window.pageClicks), 1);
  await page.close();
});

test("Escape during a full-page capture cancels it and restores the page", async () => {
  await open("/tall");
  const before = await latestId();
  await start("full");
  await page.waitForFunction(() => document.getElementById("widget").style.visibility === "hidden");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("widget").style.visibility === "");
  await page.waitForTimeout(300);
  assert.equal(await latestId(), before);
  assert.equal(await toast().count(), 0);
  await page.close();
});

test("preview page shows the capture", async () => {
  await open("/short");
  await start("visible");
  await toast().waitFor({ timeout: 30000 });
  const id = await latestId();
  const extensionId = new URL(worker.url()).host;
  const preview = await context.newPage();
  await preview.goto(`chrome-extension://${extensionId}/preview.html?id=${id}`);
  await preview.locator("img").waitFor();
  assert.equal(await preview.locator("img").evaluate((img) => img.naturalWidth), VIEWPORT.width * SCALE);
  assert.match(await preview.locator(".meta").textContent(), /^\d+ × \d+, /);
  await preview.close();
  await page.close();
});

// ------------------------------------------------------------- before/after

const PAD = 12 * SCALE;
const LABEL = 30 * SCALE;
const GAP = 12 * SCALE;

const toastButton = (name) => page.locator("framegrab-ui .toast button", { hasText: name });
const toastTitled = (title) => page.locator("framegrab-ui .toast .title", { hasText: title });

async function pickAt(x, y) {
  await start("element");
  await page.locator("framegrab-ui .hint").waitFor();
  await page.mouse.move(x + 1, y + 1);
  await page.mouse.move(x, y);
  await page.locator("framegrab-ui .box").waitFor();
  await page.mouse.click(x, y);
  await toast().waitFor({ timeout: 30000 });
}

async function setBefore() {
  await toastButton("Set as before").click();
  await toastButton("Before saved").waitFor();
}

const globalBadge = () => worker.evaluate(() => chrome.action.getBadgeText({}));

test("before/after: same element is found after a reload and stacked", async () => {
  await open("/compare-a");
  await pickAt(100, 50);
  await setBefore();
  assert.equal(await globalBadge(), "B");

  await page.goto(`${baseUrl}/compare-b`);
  await start("after");
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });
  assert.equal(await page.locator("framegrab-ui .box").count(), 0, "no picker needed");

  const x = PAD + 100;
  const shot = await readCapture([x]);
  assert.equal(shot.compare, true);
  assert.equal(shot.width, 400 * SCALE + PAD * 2);
  assert.equal(shot.height, 150 * SCALE * 2 + PAD * 2 + LABEL * 2 + GAP);
  const column = shot.columns[x];
  assert.ok(near(column[PAD + LABEL + 20], rgb("#123456")), "before on top");
  assert.ok(near(column[shot.height - PAD - 20], rgb("#fedcba")), "after below");
  assert.match(shot.filename, /_before-after_/);

  const tabBadge = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return chrome.action.getBadgeText({ tabId: tab.id });
  });
  assert.equal(tabBadge, "B", "badge returns after the capture");
  await page.close();
});

test("before/after: narrow images sit side by side", async () => {
  await open("/compare-narrow");
  await pickAt(50, 50);
  await setBefore();
  await page.evaluate(() => (document.getElementById("tall").style.background = "#fedcba"));
  await start("after");
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });

  const left = PAD + 50;
  const right = PAD + 100 * SCALE + GAP + 50;
  const shot = await readCapture([left, right]);
  assert.equal(shot.width, 100 * SCALE * 2 + PAD * 2 + GAP);
  assert.equal(shot.height, 300 * SCALE + PAD * 2 + LABEL);
  assert.ok(near(shot.columns[left][PAD + LABEL + 20], rgb("#123456")));
  assert.ok(near(shot.columns[right][PAD + LABEL + 20], rgb("#fedcba")));
  await page.close();
});

test("before/after: repeats a full-page capture", async () => {
  await open("/compare-page");
  await start("full");
  await toast().waitFor({ timeout: 30000 });
  await setBefore();
  await start("after");
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });
  const shot = await readCapture();
  assert.equal(shot.compare, true);
  assert.equal(shot.height, 1000 * SCALE + PAD * 2 + LABEL, "stitched, so the after was a full page too");
  assert.equal(shot.width, VIEWPORT.width * SCALE * 2 + PAD * 2 + GAP);
  await page.close();
});

test("before/after: a visible-area capture is repeated as a visible-area capture", async () => {
  await open("/tall");
  await start("visible");
  await toast().waitFor({ timeout: 30000 });
  await setBefore();
  await start("after");
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });
  const shot = await readCapture();
  const stacked = VIEWPORT.width / VIEWPORT.height >= 1.5;
  const h = VIEWPORT.height * SCALE;
  assert.equal(shot.height, stacked ? h * 2 + PAD * 2 + LABEL * 2 + GAP : h + PAD * 2 + LABEL);
  await page.close();
});

test("before/after: finds an element inside a shadow root", async () => {
  await open("/compare-shadow");
  await pickAt(30, 30);
  await setBefore();
  await page.reload();
  await start("after");
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });
  const shot = await readCapture();
  assert.equal(shot.width, 120 * SCALE + PAD * 2);
  await page.close();
});

test("before/after: opens the picker when the element is gone", async () => {
  await open("/compare-narrow");
  await pickAt(50, 50);
  await setBefore();
  await page.goto(`${baseUrl}/compare-gone`);
  await start("after");
  await page.locator("framegrab-ui .prompt", { hasText: "Pick the element to compare" }).waitFor();
  await page.mouse.move(50, 20);
  await page.locator("framegrab-ui .tag").waitFor();
  await page.mouse.click(50, 20);
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });
  await page.close();
});

test("before/after: Pick element replaces a wrong match", async () => {
  await open("/compare-a");
  await pickAt(100, 50);
  await setBefore();
  await start("after");
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });
  const first = await readCapture();
  await toastButton("Pick element").click();
  await page.locator("framegrab-ui .prompt").waitFor();
  await page.mouse.move(100, 50);
  await page.locator("framegrab-ui .box").waitFor();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });
  const second = await readCapture();
  assert.notEqual(second.id, first.id);
  assert.ok(second.width > first.width, "parent section is wider");
  await page.close();
});

test("before/after: regular captures stay separate and the before survives until cleared", async () => {
  await open("/compare-a");
  await pickAt(100, 50);
  await setBefore();

  await start("visible");
  await toastTitled("Copied to clipboard").waitFor({ timeout: 30000 });
  assert.equal((await readCapture()).compare, false);

  await start("after");
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });
  await start("after");
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });

  await toastButton("Clear before").click();
  await toastButton("Before cleared").waitFor();
  assert.equal(await globalBadge(), "");

  await start("after");
  await toastTitled("No before image yet").waitFor({ timeout: 30000 });
  await page.close();
});

test("before/after: a before older than the last 5 captures is kept", async () => {
  await open("/compare-a");
  await pickAt(100, 50);
  await setBefore();
  for (let i = 0; i < 6; i++) {
    await start("visible");
    await toastTitled("Copied to clipboard").waitFor({ timeout: 30000 });
    await page.waitForTimeout(20);
  }
  await start("after");
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });
  await page.close();
});

test("before/after: mixed image sizes keep the same scale", async () => {
  await open("/compare-a");
  await pickAt(100, 50);
  await setBefore();
  await worker.evaluate(() => chrome.storage.local.set({ size: "1x" }));
  await start("after");
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });
  const shot = await readCapture();
  assert.equal(shot.width, 400 + 24);
  assert.equal(shot.height, 150 * 2 + 24 + 60 + 12);
  await page.close();
});

test("popup: shows Capture after only while a before is saved, and starts it", async () => {
  await open("/compare-a");
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  assert.equal(await popup.locator(".compare").isVisible(), false);
  await popup.close();

  await page.bringToFront();
  await pickAt(100, 50);
  await setBefore();

  const popup2 = await context.newPage();
  await popup2.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup2.locator(".compare").waitFor();
  assert.ok(await popup2.locator(".compare .thumb").evaluate((img) => img.decode().then(() => img.naturalWidth > 0)));
  assert.match(await popup2.locator('kbd[data-command="capture-after"]').textContent(), /[AG]$/);
  await page.bringToFront();
  await popup2.locator('[data-mode="after"]').click();
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });
  await page.close();

  const popup3 = await context.newPage();
  await popup3.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup3.locator("#clear-before").click();
  await popup3.locator(".compare").waitFor({ state: "hidden" });
  assert.equal(await globalBadge(), "");
  await popup3.close();
});

// ------------------------------------------------------------------- blur

async function blurItems(...selectors) {
  await start("blur");
  await page.locator("framegrab-ui .hint").waitFor();
  for (const selector of selectors) {
    const box = await page.locator(selector).boundingBox();
    await page.mouse.move(box.x + 6, box.y + 6);
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.waitForFunction(
      () => document.querySelector("framegrab-ui")?.shadowRoot.querySelector(".box")?.hidden === false,
    );
    await page.waitForTimeout(60);
    await page.mouse.click(box.x + 5, box.y + 5);
  }
  await page.keyboard.press("Enter");
  await page.locator("framegrab-ui .hint").waitFor({ state: "detached" });
}

async function captureNow(mode, title = "Copied to clipboard") {
  await start(mode);
  await toastTitled(title).waitFor({ timeout: 60000 });
  return readCapture();
}

async function captureElementAt(selector) {
  await start("element");
  await page.locator("framegrab-ui .hint").waitFor();
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + 6, box.y + 6);
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.locator("framegrab-ui .box").waitFor();
  await page.waitForTimeout(60);
  await page.mouse.click(box.x + 5, box.y + 5);
  await toastTitled("Copied to clipboard").waitFor({ timeout: 30000 });
  return readCapture();
}

test("blur: the sensitive pixels are gone and clicks don't reach the page", async () => {
  await open("/blur");
  const raw = await captureElementAt("#one");
  assert.ok(raw.red > 100, "fixture text is red before blurring");
  await blurItems("#one", "#two");
  assert.equal(await page.evaluate(() => window.pageClicks), 0);
  const shot = await captureElementAt("#one");
  assert.equal(shot.red, 0);
  assert.equal(shot.width, raw.width);
  assert.equal(shot.height, raw.height);
  await page.close();
});

test("blur: the output doesn't depend on the content at all", async () => {
  await open("/blur");
  await blurItems("#one", "#two");
  const first = await captureElementAt("#one");
  const second = await captureElementAt("#two");
  assert.equal(first.hash, second.hash, "different text, identical pixels");
  await page.close();
});

test("blur: covers inline text, inputs, canvases and overflowing text", async () => {
  await open("/blur");
  await blurItems("#one", "#two", "#inline", "#field", "#art", "#spill");
  const shot = await captureNow("visible");
  assert.equal(shot.red, 0);
  await page.close();
});

test("blur: survives a stitched full-page capture", async () => {
  await open("/blur-tall");
  await page.evaluate(() => document.getElementById("deep").scrollIntoView());
  await blurItems("#deep");
  const shot = await captureNow("full");
  assert.equal(shot.red, 0);
  assert.equal(shot.height, (3000 + 50) * SCALE);
  await page.close();
});

test("blur: clicking a blurred item again unblurs it", async () => {
  await open("/blur");
  await blurItems("#one");
  await blurItems("#one");
  assert.equal(await page.evaluate(() => document.getElementById("one").style.filter), "");
  assert.equal(await page.locator("svg filter").count(), 0);
  await page.close();
});

test("blur: an element's own inline filter comes back when unblurred", async () => {
  await open("/blur");
  await page.evaluate(() => (document.getElementById("one").style.filter = "grayscale(1)"));
  await blurItems("#one");
  await blurItems("#one");
  assert.equal(await page.evaluate(() => document.getElementById("one").style.filter), "grayscale(1)");
  await page.close();
});

test("blur: re-applied after a reload, before anything is captured", async () => {
  await open("/blur");
  await blurItems("#one", "#two");
  await page.reload();
  const shot = await captureNow("visible");
  const unblurred = await page.evaluate(() => getComputedStyle(document.getElementById("inline")).color);
  assert.equal(unblurred, "rgb(255, 0, 0)");
  assert.ok(await page.evaluate(() => document.getElementById("one").style.filter.includes("framegrab-blur")));
  // Only the unblurred fixtures on the page may still be red.
  const allBlurred = await (async () => {
    await blurItems("#inline", "#field", "#art", "#spill");
    return captureNow("visible");
  })();
  assert.equal(allBlurred.red, 0);
  assert.ok(shot.red > 0);
  assert.match(await toast().innerText(), /6 blurred/);
  await page.close();
});

test("blur: warns to check the image when blurs were re-applied", async () => {
  await open("/blur");
  await blurItems("#one");
  await page.reload();
  await start("visible");
  await toastTitled("Copied to clipboard").waitFor({ timeout: 30000 });
  assert.match(await toast().innerText(), /re-applied/);
  await page.close();
});

test("blur: page re-rendering the element gets the blur back", async () => {
  await open("/blur");
  await blurItems("#one");
  await page.evaluate(() => {
    const old = document.getElementById("one");
    const fresh = old.cloneNode(true);
    fresh.removeAttribute("style");
    fresh.style.cssText = "margin:0 0 10px;width:300px;height:40px;background:#fff;color:#ff0000;font:30px monospace";
    old.replaceWith(fresh);
  });
  const shot = await captureElementAt("#one");
  assert.equal(shot.red, 0);
  await page.evaluate(() => document.getElementById("one").removeAttribute("style"));
  const again = await captureElementAt("#one");
  assert.equal(again.red, 0);
  await page.close();
});

test("blur: refuses to capture when a blurred item is missing", async () => {
  await open("/blur");
  await blurItems("#one");
  await page.evaluate(() => document.getElementById("one").remove());
  const before = await latestId();
  await start("visible");
  await toastTitled("Capture stopped").waitFor({ timeout: 30000 });
  assert.equal(await latestId(), before, "no capture stored");

  await toastButton("Capture anyway").click();
  await toastTitled("Copied to clipboard").waitFor({ timeout: 30000 });
  assert.notEqual(await latestId(), before);
  await page.close();
});

test("blur: changing mid-capture aborts instead of leaking", async () => {
  await open("/blur-tall");
  await page.evaluate(() => document.getElementById("deep").scrollIntoView());
  await blurItems("#deep");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  const before = await latestId();
  await start("full");
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById("deep").style.removeProperty("filter"));
  await toastTitled("Capture failed").waitFor({ timeout: 30000 });
  assert.match(await toast().innerText(), /blurred item changed/);
  assert.equal(await latestId(), before);
  await page.close();
});

test("blur: stays on its own page", async () => {
  await open("/blur");
  await blurItems("#one");
  await page.goto(`${baseUrl}/blur-other`);
  const shot = await captureNow("visible");
  assert.ok(shot.red > 0);
  assert.equal(await page.locator("svg filter").count(), 0);
  await page.close();
});

test("blur: a before's blurs carry into the after on another page", async () => {
  await open("/blur");
  await blurItems("#one", "#two");
  await captureElementAt("#one");
  await setBefore();
  await page.goto(`${baseUrl}/blur-b`);
  await start("after");
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });
  const shot = await readCapture();
  assert.equal(shot.compare, true);
  assert.equal(shot.red, 0);
  await page.close();
});

test("blur: an after stops if a before's blurred item is gone", async () => {
  await open("/blur");
  await blurItems("#one", "#two");
  await start("visible");
  await toastTitled("Copied to clipboard").waitFor({ timeout: 30000 });
  await setBefore();
  await page.goto(`${baseUrl}/blur-other`);
  await start("after");
  await toastTitled("Capture stopped").waitFor({ timeout: 30000 });
  await page.close();
});

test("blur: works inside a shadow root", async () => {
  await open("/blur-shadow");
  await start("blur");
  await page.locator("framegrab-ui .hint").waitFor();
  await page.mouse.move(20, 20);
  await page.waitForTimeout(100);
  await page.mouse.click(20, 20);
  await page.keyboard.press("Enter");
  await page.locator("framegrab-ui .hint").waitFor({ state: "detached" });
  const shot = await captureNow("visible");
  assert.equal(shot.red, 0);
  await page.close();
});

test("blur: works with a base href and with strict CSP", async () => {
  for (const path of ["/blur-base", "/blur-strict"]) {
    await open(path);
    await blurItems("#one");
    const shot = await captureNow("visible");
    assert.equal(shot.red, 0, path);
    await page.close();
  }
});

test("blur: body and html can't be blurred by clicking empty space", async () => {
  await open("/blur-other");
  await start("blur");
  await page.locator("framegrab-ui .hint").waitFor();
  await page.mouse.move(600, 500);
  await page.waitForTimeout(100);
  await page.mouse.click(600, 500);
  await page.keyboard.press("Enter");
  await page.locator("framegrab-ui .hint").waitFor({ state: "detached" });
  assert.equal(await page.locator("svg filter").count(), 0);
  await page.close();
});

test("popup: shows blurred items, clears them and starts blur mode", async () => {
  await open("/blur");
  const extensionId = new URL(worker.url()).host;
  await blurItems("#one", "#two");

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  await popup.reload();
  await popup.locator(".blurred:not([hidden])").waitFor();
  assert.match(await popup.locator(".blurred span").textContent(), /^2 items blurred/);
  await popup.locator("#clear-blurs").click();
  await popup.locator(".blurred").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.getElementById("one").style.filter === "");
  await popup.locator('[data-mode="blur"]').click();
  await page.locator("framegrab-ui .hint").waitFor();
  await page.keyboard.press("Enter");
  await page.close();
});

// ------------------------------------------- page scripts can't interfere

test("blur: deleting the filter from the page re-applies it before capturing", async () => {
  await open("/blur");
  await blurItems("#one");
  await page.evaluate(() => document.querySelector("svg filter").closest("svg").remove());
  const shot = await captureElementAt("#one");
  assert.equal(shot.red, 0);
  await page.close();
});

test("blur: deleting the filter mid-capture aborts instead of leaking", async () => {
  await open("/blur-tall");
  await page.evaluate(() => document.getElementById("deep").scrollIntoView());
  await blurItems("#deep");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  const before = await latestId();
  await start("full");
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector("svg filter").closest("svg").remove());
  await toastTitled("Capture failed").waitFor({ timeout: 30000 });
  assert.equal(await latestId(), before);
  await page.close();
});

test("blur: a page hiding every svg can't switch the patch off", async () => {
  await open("/blur-hide-svg");
  await blurItems("#one");
  const shot = await captureNow("visible");
  assert.equal(shot.red, 0);
  await page.close();
});

test("blur: a popup open inside a blurred item stops the capture", async () => {
  await open("/blur-popover");
  await blurItems("#holder");
  await page.evaluate(() => document.getElementById("pop").showPopover());
  const before = await latestId();
  await start("visible");
  await toastTitled("Capture failed").waitFor({ timeout: 30000 });
  assert.match(await toast().innerText(), /popup or dialog/);
  assert.equal(await latestId(), before);
  await page.close();
});

test("blur: a popup in a shadow root inside a blurred item stops the capture", async () => {
  await open("/blur-popover-shadow");
  await blurItems("#holder");
  await page.evaluate(() => window.openPop());
  const before = await latestId();
  await start("visible");
  await toastTitled("Capture failed").waitFor({ timeout: 30000 });
  assert.match(await toast().innerText(), /popup or dialog/);
  assert.equal(await latestId(), before);
  await page.close();
});

test("page scripts can't drive the picker with fake events", async () => {
  await open("/blur");
  await blurItems("#one");
  await start("blur");
  await page.locator("framegrab-ui .hint").waitFor();
  const box = await page.locator("#one").boundingBox();
  await page.evaluate(({ x, y }) => {
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
    window.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, { x: box.x + 5, y: box.y + 5 });
  await page.waitForTimeout(200);
  assert.equal(await page.locator("framegrab-ui .hint").count(), 1, "picker stays open");
  assert.ok(await page.evaluate(() => document.getElementById("one").style.filter.includes("framegrab-blur")), "still blurred");
  await page.keyboard.press("Enter");
  await page.close();
});

test("page scripts can't press the toast's buttons", async () => {
  await open("/compare-a");
  await start("visible");
  await toast().waitFor({ timeout: 30000 });
  await page.evaluate(() => {
    const buttons = document.querySelector("framegrab-ui").shadowRoot.querySelectorAll("button");
    for (const button of buttons) button.click();
  });
  await page.waitForTimeout(200);
  assert.equal(await toast().count(), 1, "close button ignored");
  assert.equal(await globalBadge(), "", "Set as before ignored");
  await page.close();
});

test("blur: a blur lost while a screenshot is being taken discards the capture", async () => {
  await open("/blur");
  await blurItems("#one");
  const before = await latestId();
  // Strip the blur the moment the capture asks for its screenshot, after the
  // check that runs before it.
  await page.evaluate(() => {
    const el = document.getElementById("one");
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 15000) clearInterval(timer);
      if (document.visibilityState === "visible" && window.__strip) {
        el.style.removeProperty("filter");
        clearInterval(timer);
      }
    }, 1);
  });
  await worker.evaluate(() => {
    const original = chrome.tabs.captureVisibleTab;
    chrome.tabs.captureVisibleTab = async (...args) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: () => { window.__strip = true; } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      chrome.tabs.captureVisibleTab = original;
      return original.apply(chrome.tabs, args);
    };
  });
  await start("visible");
  await toastTitled("Capture failed").waitFor({ timeout: 30000 });
  assert.match(await toast().innerText(), /blurred item changed/);
  assert.equal(await latestId(), before);
  await page.close();
});

// ------------------------------------------------------------- annotations

const BASE = rgb("#123456");
const PINK = rgb("#ff2d87");
const BLUE = rgb("#1f6feb");

async function openEditor() {
  await open("/annotate");
  await start("visible");
  await toast().waitFor({ timeout: 30000 });
  const [editor] = await Promise.all([context.waitForEvent("page"), toastButton("Annotate").click()]);
  await editor.locator(".stage img").waitFor();
  await editor.waitForFunction(() => document.querySelector(".stage img").naturalWidth > 0);
  await editor.bringToFront();
  const box = await editor.locator(".stage img").boundingBox();
  const natural = await editor.locator(".stage img").evaluate((img) => img.naturalWidth);
  return { editor, box, scale: natural / box.width };
}

async function drag(editor, box, from, to) {
  await editor.mouse.move(box.x + from[0], box.y + from[1]);
  await editor.mouse.down();
  await editor.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2);
  await editor.mouse.move(box.x + to[0], box.y + to[1]);
  await editor.mouse.up();
}

const count = (editor) => editor.evaluate(() => Number(document.body.dataset.count));

// Copies through the real Copy button, then reads the clipboard back.
async function copied(editor, points) {
  await editor.locator("#copy").click();
  await editor.locator("#copy", { hasText: "Copied" }).waitFor({ timeout: 15000 });
  return editor.evaluate(async (points) => {
    const [item] = await navigator.clipboard.read();
    const bitmap = await createImageBitmap(await item.getType("image/png"));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const at = ([x, y]) => {
      const i = (Math.round(y) * bitmap.width + Math.round(x)) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    let pink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 230 && data[i + 1] < 90 && data[i + 2] > 90 && data[i + 2] < 180) pink++;
    }
    return { width: bitmap.width, height: bitmap.height, pink, points: points.map(at) };
  }, points);
}

test("annotate: a box lands at the right place in the exported image", async () => {
  const { editor, box, scale } = await openEditor();
  await editor.keyboard.press("b");
  await drag(editor, box, [100, 100], [300, 200]);
  const shot = await copied(editor, [[200 * scale, 100 * scale], [200 * scale, 150 * scale], [20, 20]]);
  assert.ok(near(shot.points[0], PINK, 12), `edge is pink, got ${shot.points[0]}`);
  assert.ok(near(shot.points[1], BASE), `inside stays untouched, got ${shot.points[1]}`);
  assert.ok(near(shot.points[2], BASE), "the rest of the image is untouched");
  assert.equal(shot.width, Math.round(box.width * scale));
  await editor.close();
  await page.close();
});

test("annotate: an arrow is drawn from start to tip", async () => {
  const { editor, box, scale } = await openEditor();
  await drag(editor, box, [100, 100], [300, 100]);
  const shot = await copied(editor, [[180 * scale, 100 * scale], [180 * scale, 130 * scale]]);
  assert.ok(near(shot.points[0], PINK, 12), `shaft is pink, got ${shot.points[0]}`);
  assert.ok(near(shot.points[1], BASE), "off the line is untouched");
  await editor.close();
  await page.close();
});

test("annotate: a stray click doesn't leave a mark", async () => {
  const { editor, box } = await openEditor();
  await editor.mouse.click(box.x + 100, box.y + 100);
  assert.equal(await count(editor), 0);
  await editor.close();
  await page.close();
});

test("annotate: text is added with Enter and appears in the export", async () => {
  const { editor, box, scale } = await openEditor();
  await editor.keyboard.press("t");
  await editor.mouse.click(box.x + 100, box.y + 100);
  await editor.locator(".text-entry").waitFor();
  // Tool shortcut letters have to type normally here.
  await editor.keyboard.type("Fix <this> & \"that\" abt");
  await editor.keyboard.press("Enter");
  assert.equal(await count(editor), 1);
  assert.equal(await editor.locator(".overlay text").textContent(), 'Fix <this> & "that" abt');
  assert.equal(await editor.locator('[data-tool="text"]').getAttribute("aria-pressed"), "true");
  const shot = await copied(editor, [[20, 20]]);
  assert.ok(shot.pink > 100, "text is drawn, and those characters don't break the export");
  assert.equal(shot.width, Math.round(box.width * scale));
  await editor.close();
  await page.close();
});

test("annotate: empty text and Escape add nothing", async () => {
  const { editor, box } = await openEditor();
  await editor.keyboard.press("t");
  await editor.mouse.click(box.x + 100, box.y + 100);
  await editor.keyboard.press("Enter");
  assert.equal(await count(editor), 0);
  await editor.mouse.click(box.x + 100, box.y + 100);
  await editor.keyboard.type("nope");
  await editor.keyboard.press("Escape");
  assert.equal(await count(editor), 0);
  await editor.close();
  await page.close();
});

test("annotate: double-clicking text edits it, and clearing it removes it", async () => {
  const { editor, box } = await openEditor();
  await editor.keyboard.press("t");
  await editor.mouse.click(box.x + 100, box.y + 100);
  await editor.keyboard.type("first");
  await editor.keyboard.press("Enter");
  await editor.mouse.dblclick(box.x + 110, box.y + 100);
  await editor.locator(".text-entry").waitFor();
  await editor.keyboard.type("second");
  await editor.keyboard.press("Enter");
  assert.equal(await editor.locator(".overlay text").textContent(), "second");
  assert.equal(await count(editor), 1);
  await editor.mouse.dblclick(box.x + 110, box.y + 100);
  await editor.keyboard.press("Backspace");
  await editor.keyboard.press("Enter");
  assert.equal(await count(editor), 0);
  await editor.close();
  await page.close();
});

test("annotate: undo and redo step through changes", async () => {
  const { editor, box } = await openEditor();
  await drag(editor, box, [100, 100], [200, 100]);
  await drag(editor, box, [100, 200], [200, 200]);
  assert.equal(await count(editor), 2);
  await editor.keyboard.press("ControlOrMeta+z");
  assert.equal(await count(editor), 1);
  await editor.locator("#undo").click();
  assert.equal(await count(editor), 0);
  assert.equal(await editor.locator("#undo").isDisabled(), true);
  await editor.locator("#redo").click();
  await editor.keyboard.press("ControlOrMeta+Shift+z");
  assert.equal(await count(editor), 2);
  assert.equal(await editor.locator("#redo").isDisabled(), true);
  await editor.close();
  await page.close();
});

test("annotate: dragging moves an annotation in one undo step", async () => {
  const { editor, box, scale } = await openEditor();
  await editor.keyboard.press("b");
  await drag(editor, box, [100, 100], [300, 200]);
  await drag(editor, box, [200, 100], [200, 300]);
  assert.equal(await count(editor), 1, "dragging an edge moves it instead of drawing");
  const moved = await copied(editor, [[200 * scale, 300 * scale], [200 * scale, 100 * scale]]);
  assert.ok(near(moved.points[0], PINK, 12), `new position is pink, got ${moved.points[0]}`);
  assert.ok(near(moved.points[1], BASE), `old position is clear, got ${moved.points[1]}`);
  await editor.keyboard.press("ControlOrMeta+z");
  const back = await copied(editor, [[200 * scale, 100 * scale]]);
  assert.ok(near(back.points[0], PINK, 12), "undo puts it back");
  await editor.close();
  await page.close();
});

test("annotate: selecting allows delete and recolour, and the outline isn't exported", async () => {
  const { editor, box, scale } = await openEditor();
  await editor.keyboard.press("b");
  await drag(editor, box, [100, 100], [300, 200]);
  await editor.mouse.click(box.x + 200, box.y + 100);
  assert.equal(await editor.locator("#delete").isDisabled(), false);
  assert.equal(await editor.locator("[data-ui]").count(), 2);
  await editor.locator('.swatch[aria-label="Blue"]').click();
  // The selection outline sits 4 CSS px outside the box.
  const outline = (100 - 4 - 1.5) * scale;
  const shot = await copied(editor, [[200 * scale, 100 * scale], [200 * scale, outline]]);
  assert.ok(near(shot.points[0], BLUE, 14), `recoloured, got ${shot.points[0]}`);
  assert.ok(near(shot.points[1], [255, 255, 255], 40) || near(shot.points[1], BASE, 40), "no dashed outline in the image");
  await editor.mouse.click(box.x + 200, box.y + 100);
  await editor.keyboard.press("Backspace");
  assert.equal(await count(editor), 0);
  await editor.close();
  await page.close();
});

test("annotate: annotations survive a reload", async () => {
  const { editor, box } = await openEditor();
  await drag(editor, box, [100, 100], [200, 100]);
  await editor.waitForTimeout(150);
  await editor.reload();
  await editor.locator(".stage img").waitFor();
  await editor.waitForFunction(() => document.body.dataset.count === "1");
  await editor.close();
  await page.close();
});

test("annotate: with no annotations, Copy gives the original image", async () => {
  const { editor, box, scale } = await openEditor();
  const shot = await copied(editor, [[100, 100]]);
  assert.equal(shot.pink, 0);
  assert.equal(shot.width, Math.round(box.width * scale));
  await editor.close();
  await page.close();
});

test("annotate: Download names the annotated file separately", async () => {
  const { editor, box } = await openEditor();
  await drag(editor, box, [100, 100], [200, 100]);
  // Playwright renames downloads on disk, so record what the editor asked for.
  await editor.evaluate(() => {
    const original = chrome.downloads.download;
    chrome.downloads.download = (options) => {
      window.requested = options.filename;
      return original.call(chrome.downloads, options);
    };
  });
  await editor.locator("#download").click();
  await editor.locator("#download", { hasText: "Downloaded" }).waitFor({ timeout: 15000 });
  assert.match(await editor.evaluate(() => window.requested), /^Framegrab\/.*_annotated\.png$/);
  const state = await worker.evaluate(async () => {
    const [latest] = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 });
    return { error: latest.error ?? null, bytes: latest.bytesReceived };
  });
  assert.equal(state.error, null);
  await editor.close();
  await page.close();
});

test("annotate: drawn marks stay the same on-screen size at any image size", async () => {
  await worker.evaluate(() => chrome.storage.local.set({ size: "1x" }));
  const { editor, box, scale } = await openEditor();
  await editor.keyboard.press("b");
  await drag(editor, box, [100, 100], [300, 200]);
  const stroke = await editor.locator(".overlay rect").nth(2).evaluate((rect) => {
    const svg = rect.ownerSVGElement;
    return Number(rect.getAttribute("stroke-width")) * (svg.getBoundingClientRect().width / svg.viewBox.baseVal.width);
  });
  assert.ok(Math.abs(stroke - 3 * (1 / scale)) < 0.5, `about 3 CSS px, got ${stroke}`);
  await editor.close();
  await page.close();
});

test("annotate last capture: the popup offers it only once a capture exists", async () => {
  await worker.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const req = indexedDB.open("framegrab", 2);
      req.onsuccess = () => resolve(req.result);
    });
    const tx = db.transaction("captures", "readwrite");
    tx.objectStore("captures").clear();
    await new Promise((resolve) => (tx.oncomplete = resolve));
    db.close();
  });
  const extensionId = new URL(worker.url()).host;
  const empty = await context.newPage();
  await empty.goto(`chrome-extension://${extensionId}/popup.html`);
  await empty.locator('[data-mode="visible"]').waitFor();
  await empty.waitForTimeout(150);
  assert.equal(await empty.locator("#annotate-last").isVisible(), false);
  await empty.close();

  await open("/annotate");
  await start("visible");
  await toast().waitFor({ timeout: 30000 });
  const id = await latestId();

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator("#annotate-last").waitFor();
  assert.ok(await popup.locator("#annotate-last .thumb").evaluate((img) => img.decode().then(() => img.naturalWidth > 0)));
  const [editor] = await Promise.all([context.waitForEvent("page"), popup.locator("#annotate-last").click()]);
  await editor.waitForURL(new RegExp(`preview\\.html\\?id=${id}$`));
  await editor.locator(".stage img").waitFor();
  await editor.close();
  await page.close();
});

test("annotate last capture: picks the newest capture and keeps its annotations", async () => {
  const first = await openEditor();
  await first.editor.close();
  await page.close();
  const { editor, box } = await openEditor();
  await drag(editor, box, [100, 100], [200, 100]);
  await editor.waitForTimeout(150);
  const id = new URL(editor.url()).searchParams.get("id");
  await editor.close();

  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator("#annotate-last").waitFor();
  const [again] = await Promise.all([context.waitForEvent("page"), popup.locator("#annotate-last").click()]);
  await again.waitForURL(/preview\.html/);
  assert.equal(new URL(again.url()).searchParams.get("id"), id);
  await again.waitForFunction(() => document.body.dataset.count === "1");
  await again.close();
  await page.close();
});

test("annotate last capture: the shortcut opens the editor", async () => {
  await open("/annotate");
  await start("visible");
  await toast().waitFor({ timeout: 30000 });
  const [editor] = await Promise.all([
    context.waitForEvent("page"),
    worker.evaluate(() => chrome.commands.onCommand.dispatch("annotate-last")),
  ]);
  await editor.waitForURL(/preview\.html\?id=\d+$/);
  await editor.close();
  await page.close();
});

// --------------------------------------------------------- part of a line

// Where a piece of text is on screen, in CSS pixels.
const textBox = (needle, id = "line") =>
  page.evaluate(
    ({ needle, id }) => {
      const el = window.shadowText?.getElementById(id) ?? document.getElementById(id);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const at = node.data.indexOf(needle);
        if (at !== -1) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          const r = range.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        }
      }
      return null;
    },
    { needle, id },
  );

async function dragText(box) {
  const y = box.top + box.height / 2;
  await page.mouse.move(box.left + 0.5, y);
  await page.mouse.down();
  await page.mouse.move((box.left + box.right) / 2, y);
  await page.mouse.move(box.right - 0.5, y);
  await page.mouse.up();
}

async function blurText(...needles) {
  await start("blur");
  await page.locator("framegrab-ui .hint").waitFor();
  for (const needle of needles) await dragText(await textBox(needle));
  await page.keyboard.press("Enter");
  await page.locator("framegrab-ui .hint").waitFor({ state: "detached" });
}

const region = (box) => [
  Math.floor(box.left * SCALE),
  Math.floor(box.top * SCALE),
  Math.ceil(box.width * SCALE),
  Math.ceil(box.height * SCALE),
];

async function captureRegions(mode, ...boxes) {
  await start(mode);
  await toastTitled("Copied to clipboard").waitFor({ timeout: 60000 });
  return readCapture([], boxes.map(region));
}

test("partial blur: hides the selected text and leaves the rest of the line", async () => {
  await open("/partial");
  const secretBox = await textBox("SECRETTOKEN");
  const beforeBox = await textBox("before");
  const afterBox = await textBox("after");
  await blurText("SECRETTOKEN");
  assert.equal(await page.evaluate(() => window.pageClicks), 0);
  const shot = await captureRegions("visible", secretBox, beforeBox, afterBox);
  assert.equal(shot.regions[0].red, 0, "secret is gone");
  assert.ok(shot.regions[1].red > 50, "text before it remains");
  assert.ok(shot.regions[2].red > 50, "text after it remains");
  await page.close();
});

test("partial blur: dragging backwards works too", async () => {
  await open("/partial");
  const secretBox = await textBox("SECRETTOKEN");
  await start("blur");
  await page.locator("framegrab-ui .hint").waitFor();
  const y = secretBox.top + secretBox.height / 2;
  await page.mouse.move(secretBox.right - 0.5, y);
  await page.mouse.down();
  await page.mouse.move(secretBox.left + 40, y);
  await page.mouse.move(secretBox.left + 0.5, y);
  await page.mouse.up();
  await page.keyboard.press("Enter");
  const shot = await captureRegions("visible", secretBox);
  assert.equal(shot.regions[0].red, 0);
  await page.close();
});

test("partial blur: the page's DOM isn't changed", async () => {
  await open("/partial");
  const before = await page.locator("#line").evaluate((el) => ({ html: el.outerHTML, nodes: el.childNodes.length }));
  await blurText("SECRETTOKEN");
  const after = await page.locator("#line").evaluate((el) => ({ html: el.outerHTML, nodes: el.childNodes.length }));
  assert.deepEqual(after, before);
  await page.close();
});

test("partial blur: output doesn't depend on the text", async () => {
  const capturePatch = async (path, needle) => {
    await open(path);
    await blurText(needle);
    const shot = await captureRegions("visible", await textBox(needle));
    await page.close();
    return shot.regions[0];
  };
  const first = await capturePatch("/partial", "SECRETTOKEN");
  const second = await capturePatch("/partial-changed", "DIFFERENT00");
  assert.equal(first.red, 0);
  assert.equal(first.hash, second.hash, "different text in the same place, identical pixels");
});

test("partial blur: repeated captures don't stack up patches or warn", async () => {
  await open("/partial");
  await blurText("SECRETTOKEN");
  for (let i = 0; i < 2; i++) {
    await start("visible");
    await toastTitled("Copied to clipboard").waitFor({ timeout: 30000 });
    const text = await toast().innerText();
    assert.match(text, /1 blurred/);
    assert.doesNotMatch(text, /re-applied/);
    await page.waitForTimeout(600);
  }
  await page.reload();
  await start("visible");
  await toastTitled("Copied to clipboard").waitFor({ timeout: 30000 });
  assert.match(await toast().innerText(), /1 blurred/);
  await page.close();
});

test("partial blur: the text itself never reaches extension storage", async () => {
  await open("/partial");
  await blurText("SECRETTOKEN");
  await captureRegions("visible");
  await toastButton("Set as before").click();
  await toastButton("Before saved").waitFor();
  const stored = await worker.evaluate(async () => {
    const session = await chrome.storage.session.get(null);
    const db = await new Promise((resolve) => {
      const req = indexedDB.open("framegrab", 2);
      req.onsuccess = () => resolve(req.result);
    });
    const read = (name) =>
      new Promise((resolve) => {
        const req = db.transaction(name).objectStore(name).getAll();
        req.onsuccess = () => resolve(req.result);
      });
    const strip = (rows) => rows.map(({ blob, ...rest }) => rest);
    const out = JSON.stringify({ session, captures: strip(await read("captures")), before: strip(await read("before")) });
    db.close();
    return out;
  });
  assert.ok(stored.includes('"hash"'), "the blur was stored");
  assert.ok(!stored.includes("SECRET"), "but not its text");
  await page.close();
});

test("partial blur: spans several elements", async () => {
  await open("/partial-spans");
  const start1 = await textBox("SECRET");
  const end1 = await textBox("TOKEN");
  await start("blur");
  await page.locator("framegrab-ui .hint").waitFor();
  await dragText({ ...start1, right: end1.right });
  await page.keyboard.press("Enter");
  const shot = await captureRegions("visible", { ...start1, width: end1.right - start1.left });
  assert.equal(shot.regions[0].red, 0);
  await page.close();
});

test("partial blur: clicking the patch unblurs it", async () => {
  await open("/partial");
  const secretBox = await textBox("SECRETTOKEN");
  await blurText("SECRETTOKEN");
  await start("blur");
  await page.locator("framegrab-ui .hint").waitFor();
  await page.mouse.click(secretBox.left + 20, secretBox.top + 10);
  await page.keyboard.press("Enter");
  await page.locator("framegrab-ui .hint").waitFor({ state: "detached" });
  assert.equal(await page.locator("framegrab-blur").count(), 0, "layer is gone");
  assert.equal(await page.locator("#line").evaluate((el) => el.style.filter), "", "element wasn't blurred instead");
  const shot = await captureRegions("visible", secretBox);
  assert.ok(shot.regions[0].red > 50);
  await page.close();
});

test("partial blur: a plain click still blurs the whole element", async () => {
  await open("/partial");
  await start("blur");
  await page.locator("framegrab-ui .hint").waitFor();
  const box = await textBox("before");
  await page.mouse.move(box.left + 11, box.top + 6);
  await page.mouse.move(box.left + 10, box.top + 5);
  await page.waitForTimeout(100);
  await page.mouse.click(box.left + 10, box.top + 5);
  await page.keyboard.press("Enter");
  assert.ok(await page.locator("#line").evaluate((el) => el.style.filter.includes("framegrab-blur")));
  await page.close();
});

test("partial blur: survives a reload", async () => {
  await open("/partial");
  const secretBox = await textBox("SECRETTOKEN");
  await blurText("SECRETTOKEN");
  await page.reload();
  const shot = await captureRegions("visible", secretBox);
  assert.equal(shot.regions[0].red, 0);
  assert.match(await toast().innerText(), /re-applied/);
  await page.close();
});

test("partial blur: follows the text when text before it changes", async () => {
  await open("/partial");
  await blurText("SECRETTOKEN");
  await page.evaluate(() => {
    document.getElementById("line").firstChild.data = "new words here before SECRETTOKEN after";
  });
  const moved = await textBox("SECRETTOKEN");
  const shot = await captureRegions("visible", moved);
  assert.equal(shot.regions[0].red, 0);
  await page.close();
});

test("partial blur: refuses to capture when the text has changed", async () => {
  await open("/partial");
  await blurText("SECRETTOKEN");
  await page.evaluate(() => {
    document.getElementById("line").firstChild.data = "before NEWSECRET99 after";
  });
  const before = await latestId();
  await start("visible");
  await toastTitled("Capture stopped").waitFor({ timeout: 30000 });
  assert.equal(await latestId(), before);
  await page.close();
});

test("partial blur: text changing mid-capture aborts", async () => {
  await open("/partial-tall");
  // Centred, because at the top of the window the fixed header covers the line.
  await page.evaluate(() => document.getElementById("line").scrollIntoView({ block: "center" }));
  await blurText("SECRETTOKEN");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  const before = await latestId();
  await start("full");
  await page.waitForFunction(() => window.scrollY > 0);
  await page.evaluate(() => {
    document.getElementById("line").firstChild.data = "before REVEALEDTXT after";
  });
  await toast().waitFor({ timeout: 30000 });
  assert.match(await toast().innerText(), /^Capture failed/);
  assert.equal(await latestId(), before);
  await page.close();
});

test("partial blur: stitched capture covers the text and draws no stray patches", async () => {
  await open("/partial-tall");
  await page.evaluate(() => document.getElementById("line").scrollIntoView({ block: "center" }));
  const secretBox = await textBox("SECRETTOKEN");
  const beforeBox = await textBox("before");
  await blurText("SECRETTOKEN");
  await start("full");
  await toastTitled("Copied to clipboard").waitFor({ timeout: 60000 });
  // In page coordinates: the line sits right after three 500 px bands.
  const onLine = (box) => [Math.floor(box.left * SCALE), 1500 * SCALE, Math.ceil(box.width * SCALE), 40 * SCALE];
  const shot = await readCapture([300], [onLine(secretBox), onLine(beforeBox)]);
  assert.equal(shot.regions[0].red, 0, "the secret is gone from the stitched image");
  assert.ok(shot.regions[1].red > 50, "the unblurred words on that line remain");
  const column = shot.columns[300];
  // Bands above and below the line stay exactly as they are.
  // The 50 px line pushes everything after it down.
  assert.ok(near(column[1010 * SCALE], rgb(COLORS[2])));
  assert.ok(near(column[2060 * SCALE], rgb(COLORS[1])));
  await page.close();
});

test("partial blur: a fixed header's patch doesn't repeat down a stitched image", async () => {
  await open("/partial-tall");
  await start("blur");
  await page.locator("framegrab-ui .hint").waitFor();
  await dragText(await textBox("SECRET", "head"));
  await page.keyboard.press("Enter");
  await start("full");
  await toastTitled("Copied to clipboard").waitFor({ timeout: 60000 });
  const shot = await readCapture([40]);
  const column = shot.columns[40];
  for (let y = 60 * SCALE; y < 1500 * SCALE; y++) {
    const expected = rgb(COLORS[Math.floor(y / SCALE / BAND) % COLORS.length]);
    if (y / SCALE % BAND < 1 || BAND - y / SCALE % BAND < 1) continue;
    assert.ok(near(column[y], expected), `y=${y}: got ${column[y]}`);
  }
  await page.close();
});

test("partial blur: a patch scrolled out of its panel doesn't float over the page", async () => {
  await open("/partial-panel");
  await blurText("SECRETTOKEN");
  await page.evaluate(() => document.getElementById("panel").scrollTo({ top: 1000, behavior: "instant" }));
  await page.waitForTimeout(100);
  const below = await page.locator("#below").boundingBox();
  await start("visible");
  await toastTitled("Copied to clipboard").waitFor({ timeout: 30000 });
  const shot = await readCapture([300]);
  const column = shot.columns[300];
  assert.ok(near(column[(below.y + 20) * SCALE], [0, 255, 0]));
  assert.ok(near(column[50 * SCALE], [255, 255, 255]), "panel shows its own scrolled content, no patch");
  await page.close();
});

test("partial blur: stays on top of a dialog opened afterwards", async () => {
  await open("/partial");
  const secretBox = await textBox("SECRETTOKEN");
  await blurText("SECRETTOKEN");
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.style.cssText = "position:fixed;inset:0;margin:0;width:760px;height:60px;padding:0;border:0;background:#fff;color:#ff0000;font:30px monospace";
    dialog.textContent = "dialog above";
    document.body.append(dialog);
    dialog.showModal();
    dialog.close();
    document.getElementById("line").style.position = "relative";
    document.getElementById("line").popover = "manual";
    document.getElementById("line").style.cssText += ";inset:auto;margin:0;padding:0;border:0;display:block;position:fixed;top:0;left:0";
    document.getElementById("line").showPopover();
  });
  const box = await textBox("SECRETTOKEN");
  const shot = await captureRegions("visible", box);
  assert.equal(shot.regions[0].red, 0, `was at ${JSON.stringify(secretBox)}`);
  await page.close();
});

test("partial blur: removing the patch layer brings it back before capturing", async () => {
  await open("/partial");
  const secretBox = await textBox("SECRETTOKEN");
  await blurText("SECRETTOKEN");
  await page.evaluate(() => document.querySelector("framegrab-blur").remove());
  const shot = await captureRegions("visible", secretBox);
  assert.equal(shot.regions[0].red, 0);
  await page.close();
});

test("partial blur: page CSS can't hide the patch layer", async () => {
  await open("/partial");
  const secretBox = await textBox("SECRETTOKEN");
  await blurText("SECRETTOKEN");
  await page.addStyleTag({ content: "framegrab-blur{display:none!important;opacity:0!important}" });
  const shot = await captureRegions("visible", secretBox);
  assert.equal(shot.regions[0].red, 0);
  await page.close();
});

test("partial blur: works in shadow DOM and under strict CSP", async () => {
  for (const path of ["/partial-shadow", "/partial-strict"]) {
    await open(path);
    const secretBox = await textBox("SECRETTOKEN");
    await blurText("SECRETTOKEN");
    const shot = await captureRegions("visible", secretBox);
    assert.equal(shot.regions[0].red, 0, path);
    await page.close();
  }
});

test("partial blur: fake events can't select text", async () => {
  await open("/partial");
  const box = await textBox("SECRETTOKEN");
  await start("blur");
  await page.locator("framegrab-ui .hint").waitFor();
  await page.evaluate(({ left, right, top }) => {
    const fire = (type, x) => window.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: top + 10, button: 0, bubbles: true }));
    fire("pointerdown", left + 1);
    fire("pointermove", right - 1);
    fire("pointerup", right - 1);
  }, box);
  await page.waitForTimeout(150);
  assert.equal(await page.locator("framegrab-blur").count(), 0);
  await page.keyboard.press("Enter");
  await page.close();
});

test("partial blur: carries into a before/after on another page", async () => {
  await open("/partial");
  await blurText("SECRETTOKEN");
  await start("visible");
  await toastTitled("Copied to clipboard").waitFor({ timeout: 30000 });
  await setBefore();
  await page.goto(`${baseUrl}/partial-shifted`);
  await start("after");
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });
  const secretBox = await textBox("SECRETTOKEN");
  const wordsBox = await textBox("added");
  // Find the after image inside the combined one.
  const stacked = VIEWPORT.width / VIEWPORT.height >= 1.5;
  const h = VIEWPORT.height * SCALE;
  const w = VIEWPORT.width * SCALE;
  const inAfter = (box) => {
    const [x, y, width, height] = region(box);
    return stacked
      ? [x + PAD, y + PAD + LABEL + h + GAP + LABEL, width, height]
      : [x + PAD + w + GAP, y + PAD + LABEL, width, height];
  };
  const shot = await readCapture([], [inAfter(secretBox), inAfter(wordsBox)]);
  assert.ok(shot.compare);
  assert.equal(shot.regions[0].red, 0, "the before's blur followed the text to its new position");
  assert.ok(shot.regions[1].red > 50, "the new words around it remain");

  // That secret isn't on this page, so the after has to stop rather than guess.
  await page.goto(`${baseUrl}/partial-changed`);
  await start("after");
  await toastTitled("Capture stopped").waitFor({ timeout: 30000 });
  await page.close();
});

test("partial blur: Clear removes it", async () => {
  await open("/partial");
  const secretBox = await textBox("SECRETTOKEN");
  await blurText("SECRETTOKEN");
  await toastButton("Clear all").click();
  await page.locator("framegrab-blur").waitFor({ state: "detached" });
  const shot = await captureRegions("visible", secretBox);
  assert.ok(shot.regions[0].red > 50);
  await page.close();
});

test("partial blur: visible text inside a hidden container is still covered", async () => {
  await open("/partial-hidden-parent");
  const first = await textBox("SECRET");
  const second = await textBox("TOKEN");
  await start("blur");
  await page.locator("framegrab-ui .hint").waitFor();
  await dragText({ ...first, right: second.right });
  await page.keyboard.press("Enter");
  const whole = { ...first, width: second.right - first.left };
  const shot = await captureRegions("visible", whole);
  assert.equal(shot.regions[0].red, 0);
  await page.close();
});

test("partial blur: text that escapes a clipping ancestor is still covered", async () => {
  await open("/partial-escaped");
  const first = await textBox("SECRET");
  const second = await textBox("TOKEN");
  await start("blur");
  await page.locator("framegrab-ui .hint").waitFor();
  await dragText({ ...first, right: second.right });
  await page.keyboard.press("Enter");
  const whole = { ...first, width: second.right - first.left };
  const shot = await captureRegions("visible", whole);
  assert.equal(shot.regions[0].red, 0);
  await page.close();
});

test("partial blur: a before's text isn't searched for on another site", async () => {
  await open("/partial");
  await blurText("SECRETTOKEN");
  await start("visible");
  await toastTitled("Copied to clipboard").waitFor({ timeout: 30000 });
  await setBefore();
  // Same text, but a different origin, which must not be able to test guesses.
  const otherOrigin = baseUrl.replace("localhost", "127.0.0.1");
  await page.goto(`${otherOrigin}/partial`);
  await start("after");
  await toastTitled("Capture stopped").waitFor({ timeout: 30000 });
  assert.equal(await page.locator("framegrab-blur").count(), 0, "nothing on this page reveals a match");
  await page.close();
});

test("partial blur: a before's whole-element blur still carries to another site", async () => {
  await open("/blur");
  await blurItems("#one");
  await captureElementAt("#one");
  await setBefore();
  const otherOrigin = baseUrl.replace("localhost", "127.0.0.1");
  await page.goto(`${otherOrigin}/blur`);
  await start("after");
  await toastTitled("Before/after copied").waitFor({ timeout: 30000 });
  assert.equal((await readCapture()).red, 0);
  await page.close();
});
