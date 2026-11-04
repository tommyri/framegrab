// Covers what e2e.test.mjs can't: the extension exactly as shipped (activeTab, no
// host permissions) invoked through the real toolbar action, and real clipboard writes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extension = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");

let server, context, worker, page, profile, port;

before(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><body style="margin:0">
      <div style="width:300px;height:200px;background:#123456"></div><div style="height:3000px"></div>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;

  profile = mkdtempSync(join(tmpdir(), "framegrab-shipping-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: null,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--enable-unsafe-extension-debugging",
    ],
  });
  [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker");
  page = await context.newPage();
  await page.goto(`http://localhost:${port}/`);
  await page.bringToFront();
});

after(async () => {
  await context?.close();
  server?.close();
  rmSync(profile, { recursive: true, force: true });
});

const canReachPage = () =>
  worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => 1 });
      return true;
    } catch {
      return false;
    }
  });

async function pressToolbarButton() {
  const browserSession = await context.browser().newBrowserCDPSession();
  const pageSession = await context.newCDPSession(page);
  const { targetInfos } = await browserSession.send("Target.getTargets", { filter: [{ type: "tab" }] });
  const { targetInfo } = await pageSession.send("Target.getTargetInfo");
  const tab = targetInfos.find((target) => target.url === targetInfo.url);
  await browserSession.send("Extensions.triggerAction", {
    id: new URL(worker.url()).host,
    targetId: tab.targetId,
  });
  await page.waitForTimeout(800);
}

test("the shipped extension can reach a page only after you invoke it", async () => {
  assert.equal(await canReachPage(), false);
  await pressToolbarButton();
  assert.equal(await canReachPage(), true);
});

test("a capture lands on the clipboard as a PNG", async () => {
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "framegrab-start", mode: "visible" });
  });
  await context.grantPermissions(["clipboard-read"], { origin: `http://localhost:${port}` });
  const readClipboard = () =>
    page.evaluate(async () => {
      try {
        const [item] = await navigator.clipboard.read();
        const type = item?.types.find((name) => name.startsWith("image/"));
        if (!type) return null;
        const bitmap = await createImageBitmap(await item.getType(type));
        return { type, width: bitmap.width, innerWidth };
      } catch {
        return null;
      }
    });
  let image = null;
  for (let attempt = 0; attempt < 100 && !image; attempt++) {
    image = await readClipboard();
    if (!image) await page.waitForTimeout(200);
  }
  assert.ok(image, "an image reaches the clipboard");
  assert.equal(image.type, "image/png");
  assert.ok(image.width >= image.innerWidth);
});

test("page scripts can't see into the toast", async () => {
  const seen = await page.evaluate(() => {
    const host = document.querySelector("framegrab-ui");
    return { host: Boolean(host), root: host?.shadowRoot ?? null };
  });
  assert.deepEqual(seen, { host: true, root: null });
});

// A suggested key the browser already uses is dropped without any error, so this
// also catches shortcuts that clash on the platform running the tests.
test("all four default shortcuts are actually assigned", async () => {
  const commands = await worker.evaluate(() => chrome.commands.getAll());
  const assigned = commands.filter((command) => command.shortcut).map((command) => command.name);
  assert.deepEqual(assigned.sort(), ["capture-after", "capture-element", "capture-full", "capture-visible"]);
});
