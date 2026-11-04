import { loadCapture, saveCapture } from "./store.js";
import { COLORS, drawAnnotation, drawSelection, moved, renderAnnotated, textSize } from "./annotations.js";

const MIN_DRAG = 4;
const DOUBLE_CLICK_MS = 400;

const params = new URLSearchParams(location.search);
const id = Number(params.get("id"));
const meta = document.querySelector(".meta");
const stage = document.querySelector(".stage");
const image = document.querySelector(".stage img");
const overlay = document.querySelector(".overlay");
const entry = document.querySelector(".text-entry");
const copyButton = document.querySelector("#copy");
const downloadButton = document.querySelector("#download");
const undoButton = document.querySelector("#undo");
const redoButton = document.querySelector("#redo");
const deleteButton = document.querySelector("#delete");
const toolButtons = [...document.querySelectorAll(".tool")];

const capture = await loadCapture(id);

if (!capture) {
  meta.textContent = "This capture is no longer stored. Framegrab keeps the last 5.";
  for (const button of document.querySelectorAll("button")) button.disabled = true;
} else {
  const copy = startEditor();
  if (params.has("copy")) await copy();
}

function startEditor() {
  const { width, height } = capture;
  // CSS pixels per image pixel are constant for a capture, so marks look the
  // same size on a Retina capture as on a Standard one.
  const unit = capture.pixelRatio || 1;
  const describe = `${width} × ${height}, ${(capture.bytes / (1024 * 1024)).toFixed(1)} MB`;
  meta.textContent = describe;

  image.src = URL.createObjectURL(capture.blob);
  image.style.width = `${width / unit}px`;
  overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
  stage.hidden = false;

  let annotations = capture.annotations || [];
  let nextId = annotations.reduce((max, annotation) => Math.max(max, annotation.id), 0) + 1;
  let past = [];
  let future = [];
  let tool = "arrow";
  let color = COLORS[0].value;
  let selected = null;
  let gesture = null;
  let editing = null;
  let lastPress = null;

  function render() {
    overlay.replaceChildren();
    for (const annotation of annotations) {
      if (annotation.id === editing?.id) continue;
      overlay.append(drawAnnotation(annotation, unit));
    }
    if (selected != null) {
      const group = overlay.querySelector(`[data-id="${selected}"]`);
      if (group) overlay.append(...drawSelection(group, unit));
    }
    undoButton.disabled = !past.length;
    redoButton.disabled = !future.length;
    deleteButton.disabled = selected == null;
    document.body.dataset.count = String(annotations.length);
  }

  // Every finished change is one undo step, and is saved so a reload keeps it.
  function commit(previous) {
    past.push(previous);
    future = [];
    copyButton.textContent = "Copy";
    downloadButton.textContent = "Download";
    persist();
    render();
  }

  function persist() {
    saveCapture({ ...capture, annotations }).catch((error) => {
      meta.textContent = `${describe}. Couldn't save your annotations: ${error.message}`;
    });
  }

  function step(from, to) {
    if (!from.length) return;
    closeEntry(false);
    to.push(annotations);
    annotations = from.pop();
    selected = null;
    copyButton.textContent = "Copy";
    downloadButton.textContent = "Download";
    persist();
    render();
  }

  function removeSelected() {
    if (selected == null) return;
    const previous = annotations;
    annotations = annotations.filter((annotation) => annotation.id !== selected);
    selected = null;
    commit(previous);
  }

  function setTool(name) {
    tool = name;
    for (const button of toolButtons) button.setAttribute("aria-pressed", String(button.dataset.tool === name));
    overlay.style.cursor = name === "text" ? "text" : "crosshair";
  }

  function point(event) {
    const rect = overlay.getBoundingClientRect();
    const scale = width / rect.width;
    return {
      x: Math.min(width, Math.max(0, (event.clientX - rect.left) * scale)),
      y: Math.min(height, Math.max(0, (event.clientY - rect.top) * scale)),
    };
  }

  // ------------------------------------------------------------ text entry

  function openEntry(target) {
    editing = target;
    const scale = overlay.getBoundingClientRect().width / width;
    const size = textSize(unit) * scale;
    entry.value = target.text || "";
    entry.style.left = `${target.x * scale}px`;
    entry.style.top = `${target.y * scale}px`;
    entry.style.fontSize = `${size}px`;
    entry.style.color = target.color;
    entry.hidden = false;
    render();
    entry.focus();
    entry.select();
  }

  function closeEntry(keep) {
    if (!editing) return;
    const target = editing;
    editing = null;
    entry.hidden = true;
    const text = entry.value.trim();
    const exists = annotations.some((annotation) => annotation.id === target.id);
    if (!keep || text === (target.text || "") || (!text && !exists)) {
      render();
      return;
    }
    const previous = annotations;
    if (!text) annotations = annotations.filter((annotation) => annotation.id !== target.id);
    else if (exists) annotations = annotations.map((a) => (a.id === target.id ? { ...a, text } : a));
    else annotations = [...annotations, { ...target, text }];
    commit(previous);
  }

  entry.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") closeEntry(true);
    if (event.key === "Escape") closeEntry(false);
  });
  entry.addEventListener("blur", () => closeEntry(true));

  // --------------------------------------------------------------- gestures

  overlay.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    // A click away from open text only finishes that text.
    if (editing) {
      closeEntry(true);
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const start = point(event);
    const hit = event.target.closest?.("[data-id]");
    if (hit) {
      const hitId = Number(hit.dataset.id);
      // Detected here because each press re-renders the drawing, which replaces
      // the element under the cursor and loses the browser's dblclick event.
      const isDouble = lastPress?.id === hitId && event.timeStamp - lastPress.time < DOUBLE_CLICK_MS;
      lastPress = { id: hitId, time: event.timeStamp };
      const annotation = annotations.find((a) => a.id === hitId);
      if (isDouble && annotation.type === "text") {
        lastPress = null;
        selected = null;
        openEntry(annotation);
        return;
      }
      selected = hitId;
      gesture = { type: "move", start, before: annotations, moved: false };
    } else {
      const wasSelected = selected != null;
      selected = null;
      if (tool === "text") {
        // The first click on empty space only clears a selection.
        if (!wasSelected) openEntry({ id: nextId++, type: "text", color, x: start.x, y: start.y, text: "" });
        render();
        return;
      }
      gesture = {
        type: "draw",
        before: annotations,
        draft: { id: nextId++, type: tool, color, x1: start.x, y1: start.y, x2: start.x, y2: start.y },
        origin: { x: event.clientX, y: event.clientY },
      };
    }
    overlay.setPointerCapture(event.pointerId);
    render();
  });

  // Without this, the click would take focus from the text box it just opened.
  overlay.addEventListener("mousedown", (event) => event.preventDefault());

  overlay.addEventListener("pointermove", (event) => {
    if (!gesture) return;
    const at = point(event);
    if (gesture.type === "move") {
      const dx = at.x - gesture.start.x;
      const dy = at.y - gesture.start.y;
      if (!gesture.moved && Math.hypot(dx, dy) < MIN_DRAG * unit) return;
      gesture.moved = true;
      annotations = gesture.before.map((a) => (a.id === selected ? moved(a, dx, dy) : a));
    } else {
      gesture.draft = { ...gesture.draft, x2: at.x, y2: at.y };
      annotations = [...gesture.before, gesture.draft];
    }
    render();
  });

  function endGesture(event, cancelled) {
    if (!gesture) return;
    const finished = gesture;
    gesture = null;
    if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    if (finished.type === "move") {
      if (finished.moved && !cancelled) commit(finished.before);
      else {
        annotations = finished.before;
        render();
      }
      return;
    }
    // A stray click shouldn't leave a tiny mark behind.
    const far = Math.hypot(event.clientX - finished.origin.x, event.clientY - finished.origin.y) >= MIN_DRAG;
    if (far && !cancelled) commit(finished.before);
    else {
      annotations = finished.before;
      render();
    }
  }

  overlay.addEventListener("pointerup", (event) => endGesture(event, false));
  overlay.addEventListener("pointercancel", (event) => endGesture(event, true));

  // ---------------------------------------------------------------- toolbar

  for (const button of toolButtons) {
    button.addEventListener("click", () => setTool(button.dataset.tool));
  }

  const swatches = document.querySelector(".swatches");
  for (const { name, value } of COLORS) {
    const swatch = document.createElement("button");
    swatch.className = "swatch";
    swatch.title = name;
    swatch.setAttribute("aria-label", name);
    swatch.setAttribute("aria-pressed", String(value === color));
    swatch.style.background = value;
    swatch.addEventListener("click", () => {
      color = value;
      for (const other of swatches.children) other.setAttribute("aria-pressed", String(other === swatch));
      if (selected != null) {
        const previous = annotations;
        annotations = annotations.map((a) => (a.id === selected ? { ...a, color: value } : a));
        commit(previous);
      }
    });
    swatches.append(swatch);
  }

  undoButton.addEventListener("click", () => step(past, future));
  redoButton.addEventListener("click", () => step(future, past));
  deleteButton.addEventListener("click", removeSelected);
  copyButton.addEventListener("click", copy);
  downloadButton.addEventListener("click", download);

  document.addEventListener("keydown", (event) => {
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (command && key === "z") {
      event.preventDefault();
      if (event.shiftKey) step(future, past);
      else step(past, future);
    } else if (command && key === "c" && !String(getSelection())) {
      event.preventDefault();
      copy();
    } else if (command || event.altKey) {
      return;
    } else if (key === "a") setTool("arrow");
    else if (key === "b") setTool("box");
    else if (key === "t") setTool("text");
    else if (key === "backspace" || key === "delete") {
      event.preventDefault();
      removeSelected();
    } else if (key === "escape") {
      selected = null;
      render();
    }
  });

  setTool(tool);
  render();

  // ----------------------------------------------------------------- output

  async function output() {
    closeEntry(true);
    return annotations.length ? renderAnnotated(capture.blob, overlay, width, height) : capture.blob;
  }

  async function download() {
    try {
      const blob = await output();
      const url = URL.createObjectURL(blob);
      const filename = annotations.length ? capture.filename.replace(/\.png$/, "_annotated.png") : capture.filename;
      await chrome.downloads.download({ url, filename });
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      downloadButton.textContent = "Downloaded";
    } catch (error) {
      meta.textContent = `${describe}. Couldn't download: ${error.message}`;
    }
  }

  async function copy() {
    try {
      const blob = await output();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      copyButton.textContent = "Copied";
      meta.textContent = describe;
    } catch (error) {
      meta.textContent = `${describe}. Couldn't copy: ${error.message}`;
    }
  }

  return copy;
}
