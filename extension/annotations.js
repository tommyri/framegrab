// Annotations are plain data, drawn as SVG over the screenshot. The same SVG is
// rasterised when exporting, so what you see is exactly what gets copied.
const SVG_NS = "http://www.w3.org/2000/svg";
const HALO = "#ffffff";

export const COLORS = [
  { name: "Pink", value: "#ff2d87" },
  { name: "Blue", value: "#1f6feb" },
  { name: "Yellow", value: "#f5b400" },
];

function node(name, attrs = {}, ...children) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  element.append(...children);
  return element;
}

// A shaft that stops at the base of the head, so the tip stays sharp.
function arrowPaths({ x1, y1, x2, y2 }, unit) {
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / length;
  const uy = (y2 - y1) / length;
  const headLength = Math.min(16 * unit, length * 0.6);
  const headHalf = headLength * 0.6;
  const baseX = x2 - ux * headLength;
  const baseY = y2 - uy * headLength;
  return {
    shaft: `M${x1} ${y1}L${baseX + ux * unit} ${baseY + uy * unit}`,
    head: `M${x2} ${y2}L${baseX - uy * headHalf} ${baseY + ux * headHalf}L${baseX + uy * headHalf} ${baseY - ux * headHalf}Z`,
  };
}

function boxRect({ x1, y1, x2, y2 }) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

const DRAW = {
  arrow(annotation, unit) {
    const { shaft, head } = arrowPaths(annotation, unit);
    const line = { fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
    return [
      node("path", { d: shaft, ...line, stroke: "transparent", "stroke-width": 16 * unit, "pointer-events": "stroke" }),
      node("path", { d: shaft, ...line, stroke: HALO, "stroke-width": 6.5 * unit }),
      node("path", { d: head, fill: HALO, stroke: HALO, "stroke-width": 3.5 * unit, "stroke-linejoin": "round" }),
      node("path", { d: shaft, ...line, stroke: annotation.color, "stroke-width": 3.5 * unit }),
      node("path", { d: head, fill: annotation.color, stroke: annotation.color, "stroke-width": unit * 0.5, "stroke-linejoin": "round" }),
    ];
  },
  box(annotation, unit) {
    const rect = { ...boxRect(annotation), rx: 3 * unit, fill: "none" };
    return [
      node("rect", { ...rect, stroke: "transparent", "stroke-width": 14 * unit, "pointer-events": "stroke" }),
      node("rect", { ...rect, stroke: HALO, "stroke-width": 6 * unit }),
      node("rect", { ...rect, stroke: annotation.color, "stroke-width": 3 * unit }),
    ];
  },
  text(annotation, unit) {
    const text = node("text", {
      x: annotation.x,
      y: annotation.y,
      fill: annotation.color,
      stroke: HALO,
      "stroke-width": 4 * unit,
      "stroke-linejoin": "round",
      "paint-order": "stroke",
      "font-family": "-apple-system, system-ui, sans-serif",
      "font-size": textSize(unit),
      "font-weight": 600,
      "dominant-baseline": "central",
      "pointer-events": "bounding-box",
    });
    // textContent, so whatever you type stays text and can't break the SVG.
    text.textContent = annotation.text;
    return [text];
  },
};

export function textSize(unit) {
  return 18 * unit;
}

export function drawAnnotation(annotation, unit) {
  const group = node("g", { "data-id": annotation.id }, ...DRAW[annotation.type](annotation, unit));
  group.style.cursor = "move";
  return group;
}

export function drawSelection(group, unit) {
  const { x, y, width, height } = group.getBBox();
  const pad = 4 * unit;
  const rect = {
    x: x - pad,
    y: y - pad,
    width: width + pad * 2,
    height: height + pad * 2,
    rx: 3 * unit,
    fill: "none",
    "pointer-events": "none",
    "stroke-width": 1.5 * unit,
    "data-ui": "true",
  };
  return [
    node("rect", { ...rect, stroke: "#ffffff" }),
    node("rect", { ...rect, stroke: "#1d1830", "stroke-dasharray": `${5 * unit} ${4 * unit}` }),
  ];
}

export function moved(annotation, dx, dy) {
  if (annotation.type === "text") return { ...annotation, x: annotation.x + dx, y: annotation.y + dy };
  return {
    ...annotation,
    x1: annotation.x1 + dx,
    y1: annotation.y1 + dy,
    x2: annotation.x2 + dx,
    y2: annotation.y2 + dy,
  };
}

// Flattens the screenshot and the overlay into one PNG.
export async function renderAnnotated(blob, overlay, width, height) {
  const copy = overlay.cloneNode(true);
  for (const element of copy.querySelectorAll("[data-ui]")) element.remove();
  copy.removeAttribute("class");
  copy.setAttribute("xmlns", SVG_NS);
  copy.setAttribute("width", width);
  copy.setAttribute("height", height);
  const markup = new XMLSerializer().serializeToString(copy);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await image.decode();

  const base = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(base, 0, 0);
  ctx.drawImage(image, 0, 0, width, height);
  base.close();
  return canvas.convertToBlob({ type: "image/png" });
}
