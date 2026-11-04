import { saveCapture, loadCapture, saveBefore, loadBefore, clearBefore } from "./store.js";
import { combine } from "./compare.js";

// Chrome rejects more than two captureVisibleTab calls per second.
const MIN_CAPTURE_INTERVAL = 520;
// Largest canvas side that encodes reliably across GPUs and browsers.
const MAX_SIDE = 16384;
// Runtime messages cap out at 64 MB; base64 adds a third on top of the PNG.
const MAX_INLINE_BYTES = 45 * 1024 * 1024;

const BADGE_COLOR = "#C2185B";

const sessions = new Map();
let lastCaptureAt = 0;

const COMMAND_MODES = {
  "capture-visible": "visible",
  "capture-full": "full",
  "capture-element": "element",
  "capture-after": "after",
  "capture-blur": "blur",
};

chrome.runtime.onStartup.addListener(refreshBeforeBadge);
chrome.runtime.onInstalled.addListener(refreshBeforeBadge);

chrome.commands.onCommand.addListener(async (command) => {
  const mode = COMMAND_MODES[command];
  if (!mode) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await start(tab, mode);
  if (result.error) await flagError(tab?.id, result.error);
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const handler = handlers[message.type];
  if (!handler) return false;
  handler(message, sender).then(respond, (error) =>
    respond({ error: error?.message || String(error) }),
  );
  return true;
});

const handlers = {
  async start({ tabId, mode }) {
    const tab = await chrome.tabs.get(tabId);
    return start(tab, mode);
  },

  async begin({ width, height, label, notes }, sender) {
    const settings = await chrome.storage.local.get({ size: "full" });
    sessions.set(sender.tab.id, {
      width,
      height,
      label,
      notes: notes || [],
      size: settings.size,
      url: sender.tab.url,
      startedAt: Date.now(),
      canvas: null,
      ctx: null,
      outK: 1,
    });
    return { ok: true };
  },

  async slice({ clip, destX, destY, innerWidth, progress }, sender) {
    const session = sessions.get(sender.tab.id);
    if (!session) throw new Error("The capture was interrupted. Try again.");
    const tab = await chrome.tabs.get(sender.tab.id);
    if (!tab.active) {
      throw new Error("Capture stopped because you switched tabs. Stay on the tab until it finishes.");
    }
    const bitmap = await grabViewport(sender.tab.windowId);
    try {
      drawSlice(session, bitmap, { clip, destX, destY, innerWidth });
    } finally {
      bitmap.close();
    }
    if (progress < 1) await setBadge(sender.tab.id, `${Math.round(progress * 100)}%`);
    return { ok: true };
  },

  async finish({ height, mode, locator, compare, blurs }, sender) {
    const session = sessions.get(sender.tab.id);
    if (!session?.canvas) throw new Error("Nothing was captured. Try again.");
    sessions.delete(sender.tab.id);
    await setBadge(sender.tab.id, "");

    let canvas = trim(session, height);
    let pixelRatio = session.outK;
    const before = compare ? await loadBefore() : null;
    if (before) {
      const combined = await combine(before, canvas, session.outK);
      canvas = combined.canvas;
      pixelRatio = combined.pixelRatio;
      session.notes.push(...combined.notes);
      session.label = `${session.label}_before-after`;
    }

    const blob = await canvas.convertToBlob({ type: "image/png" });
    const id = session.startedAt;
    const filename = buildFilename(session);
    const capture = {
      id,
      blob,
      filename,
      width: canvas.width,
      height: canvas.height,
      bytes: blob.size,
      notes: session.notes,
      pixelRatio,
      mode,
      locator: locator || null,
      blurs: blurs || [],
      compare: Boolean(before),
    };
    await saveCapture(capture);

    const { blob: _omit, ...meta } = capture;
    return blob.size <= MAX_INLINE_BYTES
      ? { ...meta, base64: await toBase64(blob) }
      : { ...meta, base64: null };
  },

  async abort(_message, sender) {
    sessions.delete(sender.tab.id);
    await setBadge(sender.tab.id, "");
    return { ok: true };
  },

  async getBefore() {
    const before = await loadBefore();
    return before ? { mode: before.mode, locator: before.locator, blurs: before.blurs || [] } : null;
  },

  async setBefore({ id }) {
    const capture = await loadCapture(id);
    if (!capture) throw new Error("That capture is no longer available.");
    await saveBefore(capture);
    await refreshBeforeBadge();
    const commands = await chrome.commands.getAll();
    return { shortcut: commands.find((c) => c.name === "capture-after")?.shortcut || "" };
  },

  async clearBefore() {
    await clearBefore();
    await refreshBeforeBadge();
    return { ok: true };
  },

  // Kept for the browser session, so a reload can't bring blurred data back
  // into a screenshot. Locators hold page structure, not the page's content.
  async getBlurs({ key }) {
    const name = blurKey(key);
    return { locators: (await chrome.storage.session.get(name))[name] || [] };
  },

  async setBlurs({ key, locators }) {
    const name = blurKey(key);
    if (locators.length) await chrome.storage.session.set({ [name]: locators });
    else await chrome.storage.session.remove(name);
    return { ok: true };
  },

  async clearBlurs({ key, tabId }, sender) {
    await chrome.storage.session.remove(blurKey(key));
    const target = tabId ?? sender.tab?.id;
    if (target) await chrome.tabs.sendMessage(target, { type: "framegrab-clear-blurs" }).catch(() => {});
    return { ok: true };
  },

  async download({ id }) {
    const capture = await loadCapture(id);
    if (!capture) throw new Error("That capture is no longer available.");
    const url = `data:image/png;base64,${await toBase64(capture.blob)}`;
    await chrome.downloads.download({ url, filename: capture.filename });
    return { ok: true };
  },

  async openPreview({ id, copy }, sender) {
    const params = new URLSearchParams({ id: String(id) });
    if (copy) params.set("copy", "1");
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`preview.html?${params}`),
      index: sender.tab ? sender.tab.index + 1 : undefined,
    });
    return { ok: true };
  },
};

function blurKey(key) {
  return `blur:${key}`;
}

async function start(tab, mode) {
  if (!tab?.id) return { error: "No active tab to capture." };
  try {
    await setBadge(tab.id, "");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch {
    return { error: "Browsers block extensions on this page. Open a regular website and try again." };
  }
  // Let the popup close first so the page has focus again when the capture
  // reaches the clipboard step.
  setTimeout(() => {
    chrome.tabs.sendMessage(tab.id, { type: "framegrab-start", mode }).catch(() => {});
  }, 150);
  return { ok: true };
}

async function grabViewport(windowId) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL - Date.now();
    if (wait > 0) await delay(wait);
    lastCaptureAt = Date.now();
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      const blob = await (await fetch(dataUrl)).blob();
      return await createImageBitmap(blob);
    } catch (error) {
      const rateLimited = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(error?.message || "");
      if (!rateLimited || attempt >= 3) throw error;
      await delay(700);
    }
  }
}

function drawSlice(session, bitmap, { clip, destX, destY, innerWidth }) {
  // Device pixels per CSS pixel. Measured from the bitmap so it stays correct
  // under browser zoom and on external monitors.
  const k = bitmap.width / innerWidth;
  if (!session.canvas) {
    const wanted = session.size === "1x" ? Math.min(1, k) : k;
    const longest = Math.max(session.width, session.height);
    session.outK = Math.min(wanted, MAX_SIDE / longest);
    if (session.outK < wanted - 0.001) {
      session.notes.push("Resolution reduced to fit the maximum image size.");
    }
    session.canvas = new OffscreenCanvas(
      Math.max(1, Math.round(session.width * session.outK)),
      Math.max(1, Math.round(session.height * session.outK)),
    );
    session.ctx = session.canvas.getContext("2d");
    session.ctx.imageSmoothingQuality = "high";
  }
  const out = session.outK;
  // Round the edges rather than the sizes so neighbouring slices share an
  // exact boundary and no seam appears between them.
  const dx = Math.round(destX * out);
  const dy = Math.round(destY * out);
  const dw = Math.round((destX + clip.width) * out) - dx;
  const dh = Math.round((destY + clip.height) * out) - dy;
  const sx = Math.round(clip.x * k);
  const sy = Math.round(clip.y * k);
  const sw = Math.min(Math.round(clip.width * k), bitmap.width - sx);
  const sh = Math.min(Math.round(clip.height * k), bitmap.height - sy);
  session.ctx.drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh);
}

// The page can shrink during a long capture; drop any blank space at the end.
function trim(session, height) {
  const { canvas, outK } = session;
  const finalHeight = Math.min(canvas.height, Math.max(1, Math.round(height * outK)));
  if (finalHeight === canvas.height) return canvas;
  const trimmed = new OffscreenCanvas(canvas.width, finalHeight);
  trimmed.getContext("2d").drawImage(canvas, 0, 0);
  return trimmed;
}

function buildFilename({ url, label, startedAt }) {
  let host = "page";
  try {
    host = new URL(url).hostname || "page";
  } catch {}
  const d = new Date(startedAt);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const name = [host, label, stamp]
    .filter(Boolean)
    .join("_")
    .replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `Framegrab/${name}.png`;
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
  }
  return btoa(chunks.join(""));
}

// Clearing with null, not "", lets the tab fall back to the global "B" badge.
async function setBadge(tabId, text) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text: text || null }).catch(() => {});
}

// Shows on the toolbar icon while a before image is waiting for its after.
async function refreshBeforeBadge() {
  const before = await loadBefore();
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeText({ text: before ? "B" : "" });
}

async function flagError(tabId, message) {
  if (!tabId) return;
  await setBadge(tabId, "!");
  await chrome.action.setTitle({ tabId, title: `Framegrab: ${message}` }).catch(() => {});
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
