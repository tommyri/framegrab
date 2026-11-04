import { loadBefore, loadLatestCapture } from "./store.js";

const errorEl = document.querySelector(".error");
const compareEl = document.querySelector(".compare");

for (const button of document.querySelectorAll(".shot[data-mode]")) {
  button.addEventListener("click", () => capture(button.dataset.mode));
}

async function capture(mode) {
  errorEl.hidden = true;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await chrome.runtime.sendMessage({ type: "start", tabId: tab?.id, mode });
  if (result?.error) {
    errorEl.textContent = result.error;
    errorEl.hidden = false;
    return;
  }
  window.close();
}

document.querySelector("#clear-before").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearBefore" });
  compareEl.hidden = true;
});

const before = await loadBefore();
if (before) {
  compareEl.querySelector(".thumb").src = URL.createObjectURL(before.blob);
  compareEl.hidden = false;
}

const annotateButton = document.querySelector("#annotate-last");
const latest = await loadLatestCapture();
if (latest) {
  annotateButton.querySelector(".thumb").src = URL.createObjectURL(latest.blob);
  annotateButton.hidden = false;
  annotateButton.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "annotateLast" });
    window.close();
  });
}

const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
const blurredEl = document.querySelector(".blurred");
if (activeTab?.url) {
  const { origin, pathname } = new URL(activeTab.url);
  const key = origin + pathname;
  const { locators } = await chrome.runtime.sendMessage({ type: "getBlurs", key });
  if (locators.length) {
    blurredEl.querySelector("span").textContent =
      locators.length === 1 ? "1 item blurred on this page" : `${locators.length} items blurred on this page`;
    blurredEl.hidden = false;
  }
  document.querySelector("#clear-blurs").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "clearBlurs", key, tabId: activeTab.id });
    blurredEl.hidden = true;
  });
}

const commands = await chrome.commands.getAll();
for (const { name, shortcut } of commands) {
  const key = document.querySelector(`kbd[data-command="${name}"]`);
  if (key) key.textContent = shortcut || "";
}

const { size } = await chrome.storage.local.get({ size: "full" });
for (const input of document.querySelectorAll('input[name="size"]')) {
  input.checked = input.value === size;
  input.addEventListener("change", () => chrome.storage.local.set({ size: input.value }));
}
