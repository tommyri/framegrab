(() => {
  if (globalThis.__framegrabLoaded) return;
  globalThis.__framegrabLoaded = true;

  const MAX_CSS_HEIGHT = 16384;
  const GITHUB_LIMIT = 10 * 1024 * 1024;
  const TOAST_MS = 7000;
  const INSTANT = { behavior: "instant" };

  let busy = false;
  let cancelled = false;
  let cancelPicker = null;
  let removeToast = null;

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "framegrab-clear-blurs") return clearBlurMarks();
    if (message.type !== "framegrab-start") return;
    if (cancelPicker) return cancelPicker();
    if (busy) return;
    run(message.mode);
  });

  async function run(mode, { forcePick = false, ignoreMissing = false } = {}) {
    busy = true;
    cancelled = false;
    removeToast?.();
    const onKey = (event) => {
      if (event.isTrusted && event.key === "Escape") cancelled = true;
    };
    try {
      if (mode === "blur") return await blurMode();
      const compare = mode === "after";
      let captureMode = mode;
      let target = null;
      let before = null;
      if (compare) {
        before = await send({ type: "getBefore" });
        if (!before) {
          showToast({
            title: "No before image yet",
            detail: "Take a screenshot and choose Set as before. Then make your change and capture again.",
          });
          return;
        }
        captureMode = forcePick ? "element" : before.mode;
        // Same element as the before, without picking it again.
        if (captureMode === "element" && !forcePick) target = resolveLocator(before.locator);
      }
      // A before's blurs apply to its after too, or the data would show there.
      const blurOptions = { extra: before?.blurs || [], ignoreMissing };
      const retry = () => run(mode, { forcePick, ignoreMissing: true });
      let check = await syncBlurs(blurOptions);
      if (check.missing.length && !ignoreMissing) return showMissingBlurs(check.missing.length, retry);
      let restored = check.restored;
      let locator = null;
      if (captureMode === "element") {
        target ??= await pickElement({ prompt: compare ? "Pick the element to compare" : "" });
        if (!target) return;
        locator = locatorFor(target);
      }
      // The page may have re-rendered while the picker was open.
      check = await syncBlurs(blurOptions);
      if (check.missing.length && !ignoreMissing) return showMissingBlurs(check.missing.length, retry);
      restored += check.restored;
      window.addEventListener("keydown", onKey, true);
      await nextPaint();
      if (captureMode === "visible") await captureVisible();
      else if (captureMode === "full") await captureFullPage();
      else await captureElement(target);
      if (cancelled) throw new Cancelled();
      const blurs = allBlurLocators();
      const result = await send({ type: "finish", height: lastHeight, mode: captureMode, locator, compare, blurs });
      await deliver(result, { blurred: blurs.length, restored });
    } catch (error) {
      await send({ type: "abort" }).catch(() => {});
      if (!(error instanceof Cancelled)) {
        showToast({ title: "Capture failed", detail: error.message, tone: "error" });
      }
    } finally {
      window.removeEventListener("keydown", onKey, true);
      busy = false;
    }
  }

  class Cancelled extends Error {}

  let lastHeight = 0;

  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (response?.error) throw new Error(response.error);
    return response;
  }

  // ---------------------------------------------------------------- capture

  async function captureVisible() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    await send({ type: "begin", width, height, label: "visible" });
    await grab({ x: 0, y: 0, width, height }, 0, 0, 1);
    lastHeight = height;
  }

  async function captureFullPage() {
    const doc = document.documentElement;
    const docExtra = doc.scrollHeight - doc.clientHeight;
    const inner = findMainScroller();
    const innerExtra = inner ? inner.scrollHeight - inner.clientHeight : 0;

    if (inner && docExtra <= 40 && innerExtra > docExtra) {
      // App-shell layouts scroll a panel rather than the page.
      const view = () => scrollerView(inner);
      const rect = () => {
        const v = clientRect(inner);
        return { top: v.top - inner.scrollTop, left: v.left, width: inner.clientWidth, height: inner.scrollHeight };
      };
      return stitch({
        target: inner,
        label: "page",
        rect,
        view,
        scrollBy: (top) => inner.scrollBy({ top, ...INSTANT }),
        scrollers: [inner],
        notes: ["Captured the page's scrolling panel."],
      });
    }
    if (docExtra <= 1) return captureVisible();

    return stitch({
      target: doc,
      label: "full-page",
      rect: () => ({ top: -window.scrollY, left: 0, width: doc.clientWidth, height: doc.scrollHeight }),
      view: viewportRect,
      scrollBy: (top) => window.scrollBy({ top, ...INSTANT }),
      scrollers: [],
    });
  }

  async function captureElement(el) {
    const scroller = nearestScroller(el);
    const view = scroller ? () => scrollerView(scroller) : viewportRect;
    const scrollers = ancestorScrollers(el);
    const label = describeForFilename(el);
    const start = el.getBoundingClientRect();

    if (start.height <= view().height) {
      const saved = saveScroll(scrollers);
      try {
        // Leave the page exactly as it looks when the element is already in
        // view, so open menus and hover states stay in the picture.
        if (!isFullyInView(start)) {
          el.scrollIntoView({ block: "center", inline: "nearest", ...INSTANT });
          await settle();
        }
        const r = el.getBoundingClientRect();
        const left = Math.max(0, r.left);
        const top = Math.max(0, r.top);
        const right = Math.min(window.innerWidth, r.right);
        const bottom = Math.min(window.innerHeight, r.bottom);
        const width = right - left;
        const height = bottom - top;
        if (width < 1 || height < 1) throw new Error("That element isn't visible on the page.");
        const notes = r.width > width + 1 ? ["Cropped to the width of the window."] : [];
        await send({ type: "begin", width, height, label, notes });
        await grab({ x: left, y: top, width, height }, 0, 0, 1);
        lastHeight = height;
      } finally {
        restoreScroll(saved);
      }
      return;
    }

    return stitch({
      target: el,
      label,
      rect: () => el.getBoundingClientRect(),
      view,
      scrollBy: scroller
        ? (top) => scroller.scrollBy({ top, ...INSTANT })
        : (top) => window.scrollBy({ top, ...INSTANT }),
      scrollers,
      prepare: () => el.scrollIntoView({ block: "start", inline: "nearest", ...INSTANT }),
    });
  }

  // Scrolls through the target and captures it one screenful at a time.
  async function stitch({ target, label, rect, view, scrollBy, scrollers, prepare, notes = [] }) {
    const saved = saveScroll(scrollers);
    const overlays = new OverlayGuard(target);
    try {
      overlays.pinSticky();
      prepare?.();
      await settle();

      const first = rect();
      const v = view();
      const fullHeight = first.height;
      const height = Math.min(fullHeight, MAX_CSS_HEIGHT);
      const left = Math.max(v.left, first.left);
      const width = Math.min(v.right, first.left + first.width) - left;
      if (width < 1 || height < 1) throw new Error("That element isn't visible on the page.");

      const allNotes = [...notes];
      if (fullHeight > height) allNotes.push(`Stopped at ${MAX_CSS_HEIGHT.toLocaleString("en")}px, the maximum height.`);
      if (first.width > width + 1) allNotes.push("Cropped to the width of the window.");
      await send({ type: "begin", width, height, label, notes: allNotes });

      let covered = 0;
      let isFirst = true;
      while (covered < height - 0.5) {
        if (cancelled) throw new Cancelled();
        const before = rect();
        const vNow = view();
        scrollBy(before.top + covered - vNow.top);
        overlays.hideForSlice(isFirst);
        await settle();

        const r = rect();
        const vis = view();
        const sliceTop = Math.max(vis.top, r.top + covered);
        const sliceBottom = Math.min(vis.bottom, r.top + height);
        if (sliceBottom - sliceTop < 1) break;
        const x = Math.max(vis.left, r.left);
        await grab(
          { x, y: sliceTop, width, height: sliceBottom - sliceTop },
          0,
          sliceTop - r.top,
          Math.min(0.99, (sliceBottom - r.top) / height),
        );
        covered = sliceBottom - r.top;
        isFirst = false;
      }
      lastHeight = covered;
    } finally {
      overlays.restore();
      restoreScroll(saved);
    }
  }

  async function grab(clip, destX, destY, progress) {
    if (cancelled) throw new Cancelled();
    await prepareTextPatches();
    assertBlursIntact();
    await send({ type: "slice", clip, destX, destY, innerWidth: window.innerWidth, progress });
    // The page could have changed while the screenshot was being taken. Failing
    // here discards the capture before anything reaches the clipboard or storage.
    assertBlursIntact();
  }

  // Headers and chat widgets would repeat in every slice of a stitched image.
  class OverlayGuard {
    constructor(target) {
      this.target = target;
      this.isPage = target === document.documentElement;
      this.touched = new Map();
    }

    remember(el) {
      if (this.touched.has(el)) return;
      this.touched.set(el, ["position", "top", "bottom", "visibility"].map((prop) => [
        prop,
        el.style.getPropertyValue(prop),
        el.style.getPropertyPriority(prop),
      ]));
    }

    // A sticky element laid out normally appears once, where it belongs.
    // Runs again per slice to catch elements added while scrolling.
    pinSticky() {
      for (const el of allElements()) {
        if (this.touched.has(el) || getComputedStyle(el).position !== "sticky") continue;
        this.remember(el);
        el.style.setProperty("position", "relative", "important");
        el.style.setProperty("top", "auto", "important");
        el.style.setProperty("bottom", "auto", "important");
      }
    }

    hideForSlice(isFirst) {
      this.pinSticky();
      for (const el of allElements()) {
        if (getComputedStyle(el).position !== "fixed" || this.touched.has(el)) continue;
        if (deepContains(el, this.target)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        // Full-window layers are page backgrounds; hiding them leaves white.
        if (r.width * r.height >= window.innerWidth * window.innerHeight * 0.8) continue;
        // On the first slice a top bar stays, in its natural place. Everything
        // else would land in the middle of the finished image.
        const inTopHalf = r.top + r.height / 2 < window.innerHeight / 2;
        const keep = isFirst && this.isPage && inTopHalf;
        if (keep) continue;
        this.remember(el);
        el.style.setProperty("visibility", "hidden", "important");
      }
    }

    restore() {
      for (const [el, props] of this.touched) {
        for (const [prop, value, priority] of props) {
          if (value) el.style.setProperty(prop, value, priority);
          else el.style.removeProperty(prop);
        }
      }
      this.touched.clear();
    }
  }

  // ---------------------------------------------------------- DOM utilities

  function* allElements(root = document) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      yield node;
      if (node.shadowRoot) yield* allElements(node.shadowRoot);
      node = walker.nextNode();
    }
  }

  function composedParent(el) {
    if (el.assignedSlot) return el.assignedSlot;
    const parent = el.parentNode;
    return parent instanceof ShadowRoot ? parent.host : parent instanceof Element ? parent : null;
  }

  function deepContains(outer, inner) {
    for (let el = inner; el; el = composedParent(el)) {
      if (el === outer) return true;
    }
    return false;
  }

  function isScrollable(el) {
    if (el === document.documentElement || el === document.scrollingElement) return false;
    const overflow = getComputedStyle(el).overflowY;
    return (overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight + 1;
  }

  function nearestScroller(el) {
    for (let p = composedParent(el); p; p = composedParent(p)) {
      if (isScrollable(p)) return p;
    }
    return null;
  }

  function ancestorScrollers(el) {
    const found = [];
    for (let p = composedParent(el); p; p = composedParent(p)) {
      if (isScrollable(p)) found.push(p);
    }
    return found;
  }

  function findMainScroller() {
    const minArea = window.innerWidth * window.innerHeight * 0.25;
    let best = null;
    let bestArea = minArea;
    for (const el of allElements()) {
      if (!isScrollable(el) || el.scrollHeight - el.clientHeight <= 40) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area >= bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  function clientRect(el) {
    const r = el.getBoundingClientRect();
    return { top: r.top + el.clientTop, left: r.left + el.clientLeft, width: el.clientWidth, height: el.clientHeight };
  }

  function viewportRect() {
    const doc = document.documentElement;
    const width = doc.clientWidth;
    const height = doc.clientHeight;
    return { top: 0, left: 0, right: width, bottom: height, width, height };
  }

  function scrollerView(scroller) {
    const c = clientRect(scroller);
    const vp = viewportRect();
    const top = Math.max(vp.top, c.top);
    const left = Math.max(vp.left, c.left);
    const right = Math.min(vp.right, c.left + c.width);
    const bottom = Math.min(vp.bottom, c.top + c.height);
    return { top, left, right, bottom, width: right - left, height: bottom - top };
  }

  function isFullyInView(r) {
    return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
  }

  function saveScroll(scrollers) {
    return {
      x: window.scrollX,
      y: window.scrollY,
      scrollers: scrollers.map((el) => [el, el.scrollLeft, el.scrollTop]),
    };
  }

  function restoreScroll({ x, y, scrollers }) {
    for (const [el, left, top] of scrollers) el.scrollTo({ left, top, ...INSTANT });
    window.scrollTo({ left: x, top: y, ...INSTANT });
  }

  function nextPaint() {
    return new Promise((resolve) => {
      const fallback = setTimeout(resolve, 120);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          clearTimeout(fallback);
          resolve();
        }),
      );
    });
  }

  // Gives lazy images and scroll-triggered reveals a moment to finish.
  async function settle() {
    await nextPaint();
    const pending = [...document.images].filter((img) => {
      if (img.complete) return false;
      const r = img.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    });
    await Promise.race([
      Promise.all(pending.map((img) => img.decode().catch(() => {}))),
      new Promise((resolve) => setTimeout(resolve, 800)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  function describeForFilename(el) {
    if (el.id) return el.id.slice(0, 40);
    const named = el.getAttribute("data-testid") || el.getAttribute("aria-label");
    if (named) return named.slice(0, 40);
    return el.tagName.toLowerCase();
  }

  // ---------------------------------------------------------------- locator

  // A selector per shadow-root level, outermost first. It has to survive a page
  // reload, so it prefers ids and test ids and otherwise uses the element's
  // position, never class names, which are often generated at build time.
  function locatorFor(el) {
    const parts = [];
    for (let node = el; node; ) {
      const root = node.getRootNode();
      parts.unshift(selectorWithin(node, root));
      node = root instanceof ShadowRoot ? root.host : null;
    }
    return parts;
  }

  function selectorWithin(el, root) {
    const steps = [];
    for (let cur = el; cur; cur = cur.parentElement) {
      const stable = stableSelector(cur, root);
      if (stable) {
        steps.unshift(stable);
        break;
      }
      const name = CSS.escape(cur.localName);
      const sameTag = [...(cur.parentNode?.children || [])].filter((sib) => sib.localName === cur.localName);
      steps.unshift(sameTag.length > 1 ? `${name}:nth-of-type(${sameTag.indexOf(cur) + 1})` : name);
    }
    return steps.join(" > ");
  }

  function stableSelector(el, root) {
    const candidates = [];
    // Generated ids change between renders or builds.
    if (el.id && !/^:|^radix-|\d{4,}/.test(el.id)) candidates.push(`#${CSS.escape(el.id)}`);
    for (const attr of ["data-testid", "data-test", "data-cy"]) {
      const value = el.getAttribute(attr);
      if (value) candidates.push(`[${attr}="${CSS.escape(value)}"]`);
    }
    return candidates.find((selector) => root.querySelectorAll(selector).length === 1) || null;
  }

  function resolveLocator(parts) {
    let root = document;
    let el = null;
    try {
      for (const part of parts || []) {
        el = root?.querySelector(part);
        if (!el) return null;
        root = el.shadowRoot;
      }
    } catch {
      return null;
    }
    const rect = el?.getBoundingClientRect();
    return rect && rect.width >= 1 && rect.height >= 1 ? el : null;
  }

  // ------------------------------------------------------------------- blur

  // Blur replaces an element's pixels with a generated frosted patch. An SVG
  // filter that never reads SourceGraphic draws the same thing whatever the
  // element contains, so the image holds nothing to recover. A real CSS blur
  // over text can be reversed, which isn't acceptable for tokens or names.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const blurMarks = new Map();
  let blurFilterSeq = 0;
  let blurPageKey = pageKey();

  function pageKey() {
    return location.origin + location.pathname;
  }

  function parseColor(value) {
    const match = /^rgba?\(([^)]+)\)/.exec(value || "");
    if (!match) return null;
    const [r, g, b, a = 1] = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [r, g, b, a].some(Number.isNaN) ? null : { r, g, b, a };
  }

  // Tinted from the surroundings so the patch sits well in the page. Nothing
  // comes from the element itself, whose colour could carry meaning.
  function blurTones(surroundings) {
    let background = { r: 255, g: 255, b: 255 };
    for (let node = surroundings; node; node = composedParent(node)) {
      const color = parseColor(getComputedStyle(node).backgroundColor);
      if (color && color.a > 0.5) {
        background = color;
        break;
      }
    }
    const text = parseColor(getComputedStyle(surroundings).color) || { r: 110, g: 110, b: 120 };
    const mix = (key) => Math.round(background[key] * 0.82 + text[key] * 0.18);
    return { base: `rgb(${mix("r")}, ${mix("g")}, ${mix("b")})`, text };
  }

  function buildBlurFilter(id, surroundings) {
    const { base, text } = blurTones(surroundings);
    const node = (name, attrs, ...children) => {
      const element = document.createElementNS(SVG_NS, name);
      for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
      element.append(...children);
      return element;
    };
    const channel = (value) => (value / 255).toFixed(3);
    const tint = `0 0 0 0 ${channel(text.r)} 0 0 0 0 ${channel(text.g)} 0 0 0 0 ${channel(text.b)} 0 0 0 0.9 -0.32`;
    const svg = node(
      "svg",
      {
        "aria-hidden": "true",
        width: "0",
        height: "0",
        // A page's "svg { display: none }" would otherwise switch the filter off.
        style: "display:block!important;position:absolute!important;width:0!important;height:0!important",
      },
      node(
        "filter",
        { id, x: "0", y: "0", width: "1", height: "1", "color-interpolation-filters": "sRGB" },
        node("feFlood", { "flood-color": base, result: "base" }),
        node("feTurbulence", { type: "fractalNoise", baseFrequency: "0.018 0.05", numOctaves: "1", seed: "4", result: "noise" }),
        node("feColorMatrix", { in: "noise", type: "matrix", values: tint, result: "shade" }),
        node("feGaussianBlur", { in: "shade", stdDeviation: "3", result: "tint" }),
        node("feMerge", {}, node("feMergeNode", { in: "base" }), node("feMergeNode", { in: "tint" })),
      ),
    );
    return svg;
  }

  function paintBlur(el, mark) {
    mark.svg?.remove();
    const id = `framegrab-blur-${++blurFilterSeq}`;
    mark.id = id;
    mark.svg = buildBlurFilter(id, composedParent(el) || document.documentElement);
    // url(#id) resolves within the element's own document or shadow root.
    const root = el.getRootNode();
    (root instanceof ShadowRoot ? root : document.documentElement).append(mark.svg);
    el.style.setProperty("filter", `url("#${id}")`, "important");
  }

  function markBlur(el, locator = locatorFor(el)) {
    const mark = {
      locator,
      previous: [el.style.getPropertyValue("filter"), el.style.getPropertyPriority("filter")],
    };
    paintBlur(el, mark);
    blurMarks.set(el, mark);
  }

  function unmarkBlur(el) {
    const mark = blurMarks.get(el);
    if (!mark) return;
    mark.svg.remove();
    const [value, priority] = mark.previous;
    if (value) el.style.setProperty("filter", value, priority);
    else el.style.removeProperty("filter");
    blurMarks.delete(el);
  }

  function clearBlurMarks() {
    for (const el of [...blurMarks.keys()]) unmarkBlur(el);
    for (const mark of [...textMarks]) unmarkText(mark);
  }

  function allBlurLocators() {
    return [...blurMarks.values(), ...textMarks].map((mark) => mark.locator);
  }

  // Browser storage reorders object keys, so plain JSON wouldn't match a locator
  // that has been saved and read back.
  function blurIdentity(locator) {
    if (Array.isArray(locator)) return JSON.stringify(locator);
    const { container, start, length, hash } = locator;
    return JSON.stringify([container, start, length, hash]);
  }

  function blurOwner(el) {
    for (let node = el; node; node = composedParent(node)) {
      if (blurMarks.has(node)) return node;
    }
    return null;
  }

  // A filter that can't be resolved is ignored, and the element then renders
  // normally. So this checks the filter really exists where the element can use
  // it, not only that the style still names it.
  function isBlurIntact(el, mark) {
    if (!el.isConnected || !getComputedStyle(el).filter.includes(mark.id)) return false;
    const root = el.getRootNode();
    const filter = mark.svg.querySelector("filter");
    return (
      mark.svg.isConnected &&
      mark.svg.getRootNode() === root &&
      filter?.id === mark.id &&
      root.getElementById(mark.id) === filter &&
      getComputedStyle(mark.svg).display !== "none"
    );
  }

  // Top-layer content paints outside its ancestors' filters, so a popover or
  // modal inside a blurred element would show unblurred. allElements also walks
  // shadow roots, which querySelector can't see into.
  function hasEscapedContent(el) {
    for (const node of allElements(el)) {
      if (node.matches(":popover-open, :modal, :fullscreen")) return true;
    }
    return false;
  }

  // Blurring a page's whole body is never what a click on empty space meant.
  function toggleBlur(el) {
    const owner = blurOwner(el);
    if (owner) return unmarkBlur(owner);
    if (el === document.body || el === document.documentElement) return;
    for (const other of [...blurMarks.keys()]) {
      if (deepContains(el, other)) unmarkBlur(other);
    }
    for (const mark of [...textMarks]) {
      if (deepContains(el, mark.container)) unmarkText(mark);
    }
    markBlur(el);
  }

  function saveBlurs() {
    return send({ type: "setBlurs", key: blurPageKey, locators: allBlurLocators() });
  }

  // ------------------------------------------------------- blur part of a line

  // Selected text is covered by patches in a separate layer, positioned over the
  // text's on-screen rectangles. Wrapping the text in an element instead would
  // change the page's DOM, which breaks the frameworks that own it. As with whole
  // elements, the patches are generated, so they hold nothing from the text.
  const PATCH_CSS = `
    * { box-sizing: border-box; }
    .patch { position: fixed; top: 0; left: 0; pointer-events: none; }
  `;
  const PATCH_PAD = 1;
  const MAX_SEARCH_LENGTH = 2000000;
  const textMarks = new Set();
  let patchLayer = null;
  let patchFrame = 0;

  // Stored instead of the text, so a secret never reaches extension storage.
  function textHash(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  function textContainer(range) {
    const node = range.commonAncestorContainer;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function textLocatorFor(range) {
    const container = textContainer(range);
    if (!container) return null;
    const before = document.createRange();
    before.selectNodeContents(container);
    before.setEnd(range.startContainer, range.startOffset);
    const text = range.toString();
    return {
      container: locatorFor(container),
      start: before.toString().length,
      length: text.length,
      hash: textHash(text),
    };
  }

  // Finds the same text again, even if text before it has changed. Anything else
  // counts as not found, because then the blur would cover the wrong words.
  function resolveTextLocator(locator) {
    const container = resolveLocator(locator.container);
    if (!container) return null;
    const nodes = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const full = nodes.map((node) => node.data).join("");
    if (full.length > MAX_SEARCH_LENGTH) return null;

    const { start: wanted, length, hash } = locator;
    const matches = (at) => textHash(full.slice(at, at + length)) === hash;
    let start = -1;
    if (matches(wanted)) start = wanted;
    else {
      for (let at = 0; at + length <= full.length; at++) {
        if (matches(at) && (start === -1 || Math.abs(at - wanted) < Math.abs(start - wanted))) start = at;
      }
    }
    if (start === -1) return null;

    const range = document.createRange();
    let offset = 0;
    let startSet = false;
    for (const node of nodes) {
      const next = offset + node.data.length;
      if (!startSet && start < next) {
        range.setStart(node, start - offset);
        startSet = true;
      }
      if (startSet && start + length <= next) {
        range.setEnd(node, start + length - offset);
        return range;
      }
      offset = next;
    }
    return null;
  }

  function ensurePatchLayer() {
    if (patchLayer?.host.isConnected) return patchLayer;
    const { host, root } = mountHost(PATCH_CSS, { "pointer-events": "none" }, "framegrab-blur");
    patchLayer = { host, root };
    // A page that removed the layer also removed the filters inside it.
    for (const mark of textMarks) buildPatchFilter(mark);
    return patchLayer;
  }

  function buildPatchFilter(mark) {
    mark.id = `framegrab-blur-${++blurFilterSeq}`;
    mark.svg = buildBlurFilter(mark.id, mark.container);
    mark.base = blurTones(mark.container).base;
    mark.patches = [];
    patchLayer.root.append(mark.svg);
  }

  function markText(range, locator) {
    const mark = { range, locator, container: textContainer(range), rects: [], patches: [] };
    ensurePatchLayer();
    buildPatchFilter(mark);
    textMarks.add(mark);
    raisePatchLayer();
    positionPatches();
    if (!patchFrame) patchFrame = requestAnimationFrame(followText);
  }

  function unmarkText(mark) {
    for (const patch of mark.patches) patch.remove();
    mark.svg?.remove();
    textMarks.delete(mark);
    if (!textMarks.size && patchLayer) {
      patchLayer.host.remove();
      patchLayer = null;
    }
  }

  // Keeps patches on the text while the page scrolls or reflows.
  function followText() {
    patchFrame = 0;
    if (!textMarks.size) return;
    positionPatches();
    patchFrame = requestAnimationFrame(followText);
  }

  // Scrolling panels clip their text, so its patches have to be clipped too, or
  // they'd float over the rest of the page. Elements that can escape an ancestor's
  // clipping skip it: a patch that's too big is only untidy, one too small leaks.
  function clipBox(container) {
    let box = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    let needsPositioned = false;
    for (let node = container; node; node = composedParent(node)) {
      const style = getComputedStyle(node);
      if (node !== container && !(needsPositioned && style.position === "static")) {
        needsPositioned = false;
        if (style.overflowX !== "visible" || style.overflowY !== "visible") {
          const c = clientRect(node);
          box = {
            left: Math.max(box.left, c.left),
            top: Math.max(box.top, c.top),
            right: Math.min(box.right, c.left + c.width),
            bottom: Math.min(box.bottom, c.top + c.height),
          };
        }
      }
      if (style.position === "fixed") break;
      if (style.position === "absolute") needsPositioned = true;
    }
    return box;
  }

  function textRects(mark) {
    // The capture hides fixed headers while stitching, and their patches with them.
    if (!mark.container.checkVisibility({ checkVisibilityCSS: true })) return [];
    const clip = clipBox(mark.container);
    const rects = [];
    for (const r of mark.range.getClientRects()) {
      const left = Math.max(clip.left, r.left - PATCH_PAD);
      const top = Math.max(clip.top, r.top - PATCH_PAD);
      const right = Math.min(clip.right, r.right + PATCH_PAD);
      const bottom = Math.min(clip.bottom, r.bottom + PATCH_PAD);
      if (right - left >= 1 && bottom - top >= 1) rects.push({ left, top, right, bottom });
    }
    return rects;
  }

  function positionPatches() {
    if (!patchLayer) return;
    for (const mark of textMarks) {
      mark.rects = textRects(mark);
      while (mark.patches.length > mark.rects.length) mark.patches.pop().remove();
      while (mark.patches.length < mark.rects.length) {
        const patch = document.createElement("div");
        patch.className = "patch";
        // The solid colour alone already hides the text, whatever happens to the filter.
        patch.style.background = mark.base;
        patch.style.filter = `url("#${mark.id}")`;
        patchLayer.root.append(patch);
        mark.patches.push(patch);
      }
      mark.rects.forEach(({ left, top, right, bottom }, i) => {
        const { style } = mark.patches[i];
        style.transform = `translate(${left}px, ${top}px)`;
        style.width = `${right - left}px`;
        style.height = `${bottom - top}px`;
      });
    }
  }

  // A dialog or popover opened later would otherwise paint over the patches.
  function raisePatchLayer() {
    if (!patchLayer) return;
    try {
      patchLayer.host.hidePopover();
      patchLayer.host.showPopover();
    } catch {}
  }

  async function prepareTextPatches() {
    if (!textMarks.size) return;
    ensurePatchLayer();
    raisePatchLayer();
    positionPatches();
    await nextPaint();
    positionPatches();
  }

  function isTextIntact(mark) {
    return mark.container.isConnected && textHash(mark.range.toString()) === mark.locator.hash;
  }

  function textMarkAt(point) {
    if (!point) return null;
    for (const mark of textMarks) {
      for (const { left, top, right, bottom } of mark.rects) {
        if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) return mark;
      }
    }
    return null;
  }

  // Brings the page in line with every blur that should be on it. Anything that
  // can't be found comes back as missing, so the caller can refuse to capture.
  async function syncBlurs({ extra = [], ignoreMissing = false } = {}) {
    const key = pageKey();
    if (key !== blurPageKey) {
      // A client-side navigation. Blurs from the old page that are gone stay
      // stored under that page's address.
      for (const el of [...blurMarks.keys()]) {
        if (!el.isConnected) unmarkBlur(el);
      }
      for (const mark of [...textMarks]) {
        if (!mark.container.isConnected) unmarkText(mark);
      }
      blurPageKey = key;
    }
    const { locators: stored } = await send({ type: "getBlurs", key });
    const wanted = new Map();
    for (const locator of [...stored, ...extra, ...allBlurLocators()]) {
      wanted.set(blurIdentity(locator), locator);
    }

    let restored = 0;
    for (const [el, mark] of [...blurMarks]) {
      if (!el.isConnected) unmarkBlur(el);
      else if (!isBlurIntact(el, mark)) {
        paintBlur(el, mark);
        restored++;
      }
    }
    for (const mark of [...textMarks]) {
      if (!isTextIntact(mark)) unmarkText(mark);
    }

    const applied = new Set(allBlurLocators().map(blurIdentity));
    const missing = [];
    for (const [identity, locator] of wanted) {
      if (applied.has(identity)) continue;
      if (Array.isArray(locator)) {
        const el = resolveLocator(locator);
        if (!el) {
          missing.push(locator);
        } else if (!blurOwner(el)) {
          markBlur(el, locator);
          restored++;
        }
      } else {
        const range = resolveTextLocator(locator);
        if (!range) {
          missing.push(locator);
        } else if (!blurOwner(textContainer(range))) {
          markText(range, locator);
          restored++;
        }
      }
    }
    if (!missing.length || ignoreMissing) await saveBlurs();
    if (restored) {
      await nextPaint();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { missing, restored };
  }

  function assertBlursIntact() {
    for (const [el, mark] of blurMarks) {
      if (hasEscapedContent(el)) {
        throw new Error("A popup or dialog is open inside a blurred item, so nothing was captured. Close it and try again.");
      }
      if (!isBlurIntact(el, mark)) {
        throw new Error("A blurred item changed during the capture, so nothing was captured. Try again.");
      }
    }
    for (const mark of textMarks) {
      if (!isTextIntact(mark) || !patchLayer?.host.isConnected) {
        throw new Error("A blurred item changed during the capture, so nothing was captured. Try again.");
      }
    }
  }

  function showMissingBlurs(count, retry) {
    const items = count === 1 ? "1 blurred item" : `${count} blurred items`;
    showToast({
      title: "Capture stopped",
      detail: `${items} couldn't be found on this page, so that data could show in the image.`,
      tone: "error",
      actions: [
        { label: "Blur items", primary: true, run: () => { removeToast?.(); run("blur"); } },
        { label: "Capture anyway", run: () => { removeToast?.(); retry(); } },
      ],
    });
  }

  const blurCountText = () => {
    const count = blurMarks.size + textMarks.size;
    return count === 1 ? "1 item blurred" : `${count} items blurred`;
  };

  async function blurMode() {
    await syncBlurs({ ignoreMissing: true });
    await pickElement({
      prompt: blurCountText(),
      onPick: (el, point) => {
        const textMark = textMarkAt(point);
        if (textMark) unmarkText(textMark);
        else toggleBlur(el);
        return blurCountText();
      },
      onTextRange: (range) => {
        const container = textContainer(range);
        const locator = range.toString().trim() && !blurOwner(container) ? textLocatorFor(range) : null;
        if (locator) markText(range, locator);
        return blurCountText();
      },
    });
    await saveBlurs();
    if (!blurMarks.size && !textMarks.size) return;
    showToast({
      title: blurCountText(),
      detail: "They stay blurred in your screenshots until you clear them.",
      actions: [
        {
          label: "Clear all",
          run: async (button) => {
            button.disabled = true;
            await send({ type: "clearBlurs", key: blurPageKey });
            button.textContent = "Cleared";
          },
        },
      ],
    });
  }

  // ----------------------------------------------------------------- picker

  function mountHost(css, hostStyles, tagName = "framegrab-ui") {
    const host = document.createElement(tagName);
    const fixed = {
      all: "initial",
      ...hostStyles,
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      overflow: "visible",
      "z-index": "2147483647",
    };
    for (const [prop, value] of Object.entries(fixed)) host.style.setProperty(prop, value, "important");
    // Closed, so page scripts can't read the thumbnail, which can include a before
    // image from another site, or press the buttons.
    const root = host.attachShadow({ mode: "closed" });
    // A constructed stylesheet isn't subject to the page's CSP.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
    document.documentElement.append(host);
    // The top layer sits above modal dialogs and popovers.
    try {
      host.popover = "manual";
      host.showPopover();
    } catch {}
    return { host, root };
  }

  const PICKER_CSS = `
    * { box-sizing: border-box; }
    .box {
      position: fixed; top: 0; left: 0; width: 0; height: 0;
      pointer-events: none;
      box-shadow: 0 0 0 100vmax rgba(20, 16, 32, .42);
      outline: 1px solid rgba(255, 255, 255, .9);
    }
    .tick { position: absolute; width: 14px; height: 14px; border: 0 solid #ff2d87; }
    .tl { top: -2px; left: -2px; border-width: 3px 0 0 3px; }
    .tr { top: -2px; right: -2px; border-width: 3px 3px 0 0; }
    .bl { bottom: -2px; left: -2px; border-width: 0 0 3px 3px; }
    .br { bottom: -2px; right: -2px; border-width: 0 3px 3px 0; }
    .tag {
      position: fixed; top: 0; left: 0; max-width: min(520px, 90vw);
      padding: 4px 8px; border-radius: 4px;
      background: #ff2d87; color: #fff;
      font: 500 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      pointer-events: none;
    }
    .hint {
      position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
      display: flex; gap: 14px; padding: 8px 14px; border-radius: 8px;
      background: #1d1830; color: #e9e6f2;
      font: 13px/1.3 system-ui, -apple-system, sans-serif;
      white-space: nowrap; pointer-events: none;
    }
    kbd {
      font: inherit; font-weight: 600; color: #fff;
      margin-right: 3px;
    }
    .prompt { font-weight: 600; color: #ff9bc4; }
    .selection {
      position: fixed; top: 0; left: 0; pointer-events: none;
      background: rgba(255, 45, 135, .4);
      outline: 1px solid #ff2d87;
    }
  `;

  // With onPick the picker stays open and each pick calls it; whatever it
  // returns replaces the prompt. Without it, the first pick resolves the promise.
  // With onTextRange, dragging across text selects part of it instead.
  function pickElement({ prompt = "", onPick = null, onTextRange = null } = {}) {
    return new Promise((resolve) => {
      const { host, root } = mountHost(PICKER_CSS, { cursor: "crosshair" });
      const make = (tag, className, text) => {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text) el.textContent = text;
        return el;
      };
      const box = make("div", "box");
      box.append(...["tl", "tr", "bl", "br"].map((corner) => make("i", `tick ${corner}`)));
      const tag = make("div", "tag");
      box.hidden = tag.hidden = true;
      const hint = make("div", "hint");
      const promptEl = make("span", "prompt", prompt);
      if (prompt) hint.append(promptEl);
      const items = onPick
        ? [[["Click"], "blur or unblur"], [["Drag"], "across text to blur part"], [["↑", "↓"], "parent / child"], [["Enter"], "done"]]
        : [[["Click"], "capture"], [["↑", "↓"], "parent / child"], [["Esc"], "cancel"]];
      for (const [keys, action] of items) {
        const item = make("span");
        item.append(...keys.map((key) => make("kbd", "", key)), action);
        hint.append(item);
      }
      root.append(box, tag, hint);

      let current = null;
      let trail = [];
      let pointer = null;
      let frame = 0;
      let press = null;
      let selection = null;
      let selectionEls = [];
      let justDragged = false;

      // Our own layer has to be out of the way for this kind of hit test.
      function caretAt(x, y, shadowRoots) {
        host.style.setProperty("pointer-events", "none", "important");
        try {
          let node;
          let offset;
          if (document.caretPositionFromPoint) {
            const position = document.caretPositionFromPoint(x, y, { shadowRoots });
            node = position?.offsetNode;
            offset = position?.offset;
          } else {
            const range = document.caretRangeFromPoint?.(x, y);
            node = range?.startContainer;
            offset = range?.startOffset;
          }
          return node?.nodeType === Node.TEXT_NODE ? { node, offset } : null;
        } finally {
          host.style.removeProperty("pointer-events");
        }
      }

      function rangeBetween(a, b) {
        if (a.node.getRootNode() !== b.node.getRootNode()) return null;
        const range = document.createRange();
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
        if (range.collapsed) {
          range.setStart(b.node, b.offset);
          range.setEnd(a.node, a.offset);
        }
        return range.collapsed ? null : range;
      }

      function paintSelection() {
        for (const el of selectionEls) el.remove();
        selectionEls = [...(selection?.getClientRects() || [])].map((r) => {
          const el = make("div", "selection");
          el.style.transform = `translate(${r.left}px, ${r.top}px)`;
          el.style.width = `${r.width}px`;
          el.style.height = `${r.height}px`;
          root.append(el);
          return el;
        });
      }

      function onDown(event) {
        swallow(event);
        if (!event.isTrusted || !onTextRange || event.button !== 0) return;
        const shadowRoots = [...allElements()].map((el) => el.shadowRoot).filter(Boolean);
        const caret = caretAt(event.clientX, event.clientY, shadowRoots);
        press = caret && { x: event.clientX, y: event.clientY, caret, shadowRoots, dragging: false };
      }

      function onUp(event) {
        swallow(event);
        if (!event.isTrusted || !press) return;
        const { dragging } = press;
        press = null;
        if (!dragging) return;
        justDragged = true;
        const range = selection;
        selection = null;
        paintSelection();
        if (range) promptEl.textContent = onTextRange(range);
      }

      function elementAt(x, y) {
        let el = document.elementsFromPoint(x, y).find((e) => e !== host);
        while (el?.shadowRoot) {
          const inner = el.shadowRoot.elementsFromPoint(x, y).find((e) => e !== host && e !== el);
          if (!inner || !deepContains(el, inner)) break;
          el = inner;
        }
        return el || null;
      }

      function select(el) {
        current = el;
        paint();
      }

      function paint() {
        if (!current?.isConnected) {
          box.hidden = true;
          tag.hidden = true;
          return;
        }
        const r = current.getBoundingClientRect();
        box.hidden = false;
        box.style.transform = `translate(${r.left}px, ${r.top}px)`;
        box.style.width = `${r.width}px`;
        box.style.height = `${r.height}px`;

        tag.hidden = false;
        tag.textContent = `${selectorFor(current)}  ${Math.round(r.width)} × ${Math.round(r.height)}`;
        const tagHeight = tag.offsetHeight;
        const below = r.bottom + 6 + tagHeight < window.innerHeight;
        const y = below ? Math.max(6, r.bottom + 6) : Math.max(6, r.top - tagHeight - 6);
        const x = Math.min(Math.max(6, r.left), window.innerWidth - tag.offsetWidth - 6);
        tag.style.transform = `translate(${x}px, ${y}px)`;
      }

      function swallow(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }

      // Page scripts can dispatch events too. They must not be able to pick,
      // unblur or confirm anything, so only real input counts.
      function onMove(event) {
        swallow(event);
        if (!event.isTrusted) return;
        pointer = { x: event.clientX, y: event.clientY };
        if (press) {
          if (!press.dragging && Math.hypot(pointer.x - press.x, pointer.y - press.y) >= 4) {
            press.dragging = true;
            box.hidden = tag.hidden = true;
          }
          if (press.dragging) {
            const caret = caretAt(pointer.x, pointer.y, press.shadowRoots);
            if (caret) selection = rangeBetween(press.caret, caret);
            paintSelection();
            return;
          }
        }
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          const el = elementAt(pointer.x, pointer.y);
          if (el && el !== current) {
            trail = [];
            select(el);
          }
        });
      }

      function pick() {
        if (!current) return;
        promptEl.textContent = onPick(current, pointer);
        paint();
      }

      function onClick(event) {
        swallow(event);
        if (!event.isTrusted) return;
        // The click that ends a drag has already done its job.
        if (justDragged) {
          justDragged = false;
          return;
        }
        pointer = { x: event.clientX, y: event.clientY };
        const el = elementAt(event.clientX, event.clientY);
        if (!trail.length && el) current = el;
        if (onPick) pick();
        else finish(current);
      }

      function onKey(event) {
        swallow(event);
        if (!event.isTrusted) return;
        if (event.key === "Escape") return finish(null);
        if (onPick && event.key === "Enter") return finish(null);
        if (onPick && event.key === " ") return pick();
        if (event.key === "Enter" || event.key === " ") return finish(current);
        if (event.key === "ArrowUp" && current) {
          const parent = composedParent(current);
          if (parent && parent !== document.documentElement) {
            trail.push(current);
            select(parent);
          }
        }
        if (event.key === "ArrowDown") {
          const child = trail.pop() || current?.firstElementChild;
          if (child) select(child);
        }
      }

      function onWheel(event) {
        swallow(event);
        if (!event.isTrusted) return;
        const start = pointer ? elementAt(pointer.x, pointer.y) : null;
        const scroller = start && nearestScroller(start);
        if (scroller) scroller.scrollBy({ left: event.deltaX, top: event.deltaY, ...INSTANT });
        else window.scrollBy({ left: event.deltaX, top: event.deltaY, ...INSTANT });
      }

      const swallowed = ["mousedown", "mouseup", "dblclick", "auxclick", "contextmenu", "keyup", "keypress", "touchstart", "touchend"];
      const options = { capture: true, passive: false };

      function attach(add) {
        const method = add ? "addEventListener" : "removeEventListener";
        window[method]("pointermove", onMove, options);
        window[method]("pointerdown", onDown, options);
        window[method]("pointerup", onUp, options);
        window[method]("mousemove", swallow, options);
        window[method]("click", onClick, options);
        window[method]("keydown", onKey, options);
        window[method]("wheel", onWheel, options);
        for (const type of swallowed) window[method](type, swallow, options);
        window[method]("scroll", paint, { capture: true, passive: true });
        window[method]("resize", paint, { passive: true });
      }

      function finish(result) {
        attach(false);
        cancelAnimationFrame(frame);
        for (const el of selectionEls) el.remove();
        host.remove();
        cancelPicker = null;
        resolve(result);
      }

      cancelPicker = () => finish(null);
      attach(true);
    });
  }

  function selectorFor(el) {
    let text = el.tagName.toLowerCase();
    if (el.id) text += `#${el.id}`;
    else if (typeof el.className === "string" && el.className.trim()) {
      text += `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`;
    }
    return text;
  }

  // ------------------------------------------------------------------ toast

  const TOAST_CSS = `
    * { box-sizing: border-box; }
    .toast {
      position: fixed; top: 16px; right: 16px; width: 320px;
      display: grid; grid-template-columns: 64px 1fr; gap: 12px;
      padding: 12px; border-radius: 10px;
      background: #1d1830; color: #e9e6f2;
      box-shadow: 0 10px 36px rgba(20, 16, 32, .45);
      font: 13px/1.4 system-ui, -apple-system, sans-serif;
      pointer-events: auto;
    }
    .toast.plain { grid-template-columns: 1fr; }
    canvas {
      width: 64px; height: 64px; border-radius: 5px;
      object-fit: contain; background: #fff;
    }
    .title { margin: 0; font-weight: 600; color: #fff; }
    .tone-error .title { color: #ff9bc4; }
    .detail { margin: 2px 0 0; color: #b6b0c9; overflow-wrap: anywhere; }
    .warn { margin: 6px 0 0; color: #ffc48a; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    button {
      appearance: none; border: 0; border-radius: 5px; padding: 4px 9px;
      background: #352d52; color: #fff; cursor: pointer;
      font: 500 12px/1.4 system-ui, -apple-system, sans-serif;
    }
    button:hover { background: #453b6a; }
    button:focus-visible { outline: 2px solid #ff2d87; outline-offset: 1px; }
    button.primary { background: #ff2d87; }
    button.primary:hover { background: #e01e73; }
    .close {
      position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; padding: 0;
      background: transparent; color: #b6b0c9; font-size: 15px; line-height: 1;
    }
  `;

  function showToast({ title, detail, warnings = [], tone, bitmap, actions = [] }) {
    removeToast?.();
    const { host, root } = mountHost(TOAST_CSS, { "pointer-events": "none" });
    const toast = document.createElement("div");
    toast.className = `toast ${bitmap ? "" : "plain"} ${tone ? `tone-${tone}` : ""}`;
    toast.setAttribute("role", "status");
    root.append(toast);

    if (bitmap) {
      const canvas = document.createElement("canvas");
      const side = 128;
      canvas.width = canvas.height = side;
      const scale = Math.min(side / bitmap.width, side / bitmap.height);
      const w = bitmap.width * scale;
      const h = bitmap.height * scale;
      canvas.getContext("2d").drawImage(bitmap, (side - w) / 2, (side - h) / 2, w, h);
      toast.append(canvas);
    }

    const body = document.createElement("div");
    const addText = (cls, text) => {
      const p = document.createElement("p");
      p.className = cls;
      p.textContent = text;
      body.append(p);
      return p;
    };
    addText("title", title);
    if (detail) addText("detail", detail);
    for (const warning of warnings) addText("warn", warning);

    const row = document.createElement("div");
    row.className = "actions";
    for (const action of actions) {
      const button = document.createElement("button");
      button.textContent = action.label;
      if (action.primary) button.className = "primary";
      button.addEventListener("click", (event) => {
        if (event.isTrusted) action.run(button);
      });
      row.append(button);
    }
    if (actions.length) body.append(row);
    toast.append(body);

    const close = document.createElement("button");
    close.className = "close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", (event) => {
      if (event.isTrusted) removeToast?.();
    });
    toast.append(close);

    let timer = setTimeout(() => removeToast?.(), TOAST_MS);
    toast.addEventListener("mouseenter", () => clearTimeout(timer));
    toast.addEventListener("mouseleave", () => {
      timer = setTimeout(() => removeToast?.(), TOAST_MS);
    });

    removeToast = () => {
      clearTimeout(timer);
      host.remove();
      removeToast = null;
    };
  }

  // --------------------------------------------------------------- delivery

  function decode(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: "image/png" });
  }

  async function writeClipboard(blob) {
    if (!navigator.clipboard?.write) throw new Error("clipboard unavailable");
    await waitForFocus();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }

  // The clipboard rejects unfocused documents, and focus takes a moment to come
  // back to the page after the popup closes.
  function waitForFocus() {
    if (document.hasFocus()) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      window.addEventListener("focus", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  async function deliver(capture, { blurred, restored }) {
    const { id, width, height, bytes, notes, base64, compare, mode } = capture;
    const blob = base64 ? decode(base64) : null;
    const bitmap = blob ? await createImageBitmap(blob).catch(() => null) : null;

    let copied = false;
    if (blob) {
      try {
        await writeClipboard(blob);
        copied = true;
      } catch {}
    }

    const warnings = [...notes];
    if (restored) warnings.push("Blurs were re-applied after the page changed. Check them before sharing.");
    if (bytes > GITHUB_LIMIT) {
      warnings.push(`GitHub rejects images over 10 MB. Switch the image size to Standard in the popup.`);
    }

    const download = {
      label: "Download",
      run: async (button) => {
        button.disabled = true;
        try {
          await send({ type: "download", id });
          button.textContent = "Downloaded";
        } catch (error) {
          button.disabled = false;
          button.textContent = error.message;
        }
      },
    };
    const open = { label: "Annotate", run: () => send({ type: "openPreview", id }) };
    const copyAction = {
      label: "Copy",
      primary: true,
      run: async (button) => {
        try {
          await writeClipboard(blob);
          button.textContent = "Copied";
        } catch {
          // Plain-http pages have no clipboard API. The preview tab always does.
          await send({ type: "openPreview", id, copy: true });
        }
      },
    };

    const setBefore = {
      label: "Set as before",
      run: async (button) => {
        button.disabled = true;
        const { shortcut } = await send({ type: "setBefore", id });
        button.textContent = "Before saved";
        const how = shortcut ? `press ${shortcut} or choose Capture after in the popup` : "choose Capture after in the popup";
        button.closest(".toast").querySelector(".detail").textContent = `Make your change, then ${how}.`;
      },
    };
    const clearBefore = {
      label: "Clear before",
      run: async (button) => {
        button.disabled = true;
        await send({ type: "clearBefore" });
        button.textContent = "Before cleared";
      },
    };
    const pickAgain = {
      label: "Pick element",
      run: () => {
        removeToast?.();
        run("after", { forcePick: true });
      },
    };

    const extras = compare ? [clearBefore, ...(mode === "element" ? [pickAgain] : [])] : [setBefore];
    const output = copied
      ? [download, open]
      : blob
        ? [copyAction, download, open]
        : [{ ...open, primary: true }, download];
    const subject = compare ? "Before/after" : "Screenshot";
    showToast({
      title: copied ? (compare ? "Before/after copied" : "Copied to clipboard") : `${subject} ready`,
      detail: `${width} × ${height}, ${formatBytes(bytes)}${blurred ? `, ${blurred} blurred` : ""}`,
      warnings,
      bitmap,
      actions: [...output, ...extras],
    });
    bitmap?.close();
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
})();
