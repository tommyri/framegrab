import { loadCapture } from "./store.js";

const params = new URLSearchParams(location.search);
const id = Number(params.get("id"));
const meta = document.querySelector(".meta");
const image = document.querySelector("img");
const copyButton = document.querySelector("#copy");
const downloadButton = document.querySelector("#download");

const capture = await loadCapture(id);

if (!capture) {
  meta.textContent = "This capture is no longer stored. Framegrab keeps the last 5.";
  copyButton.disabled = downloadButton.disabled = true;
} else {
  const megabytes = (capture.bytes / (1024 * 1024)).toFixed(1);
  const describe = `${capture.width} × ${capture.height}, ${megabytes} MB`;
  meta.textContent = describe;
  image.src = URL.createObjectURL(capture.blob);
  image.hidden = false;

  const copy = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": capture.blob })]);
      copyButton.textContent = "Copied";
    } catch (error) {
      meta.textContent = `${describe}. Couldn't copy: ${error.message}`;
    }
  };

  copyButton.addEventListener("click", copy);
  downloadButton.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "download", id });
    downloadButton.textContent = "Downloaded";
  });

  if (params.has("copy")) await copy();
}
