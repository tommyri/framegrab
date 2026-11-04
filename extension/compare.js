// Combines a saved "before" capture and a new "after" canvas into one labelled image.
const MAX_SIDE = 16384;
const FRAME = "#1d1830";
const BEFORE_LABEL = "#c9c4da";
const AFTER_LABEL = "#ffffff";

// Sizes in CSS pixels, scaled by the after image's pixel ratio.
const PAD = 12;
const GAP = 12;
const LABEL = 30;
const MIN_COLUMN = 64;

// Wider images stack so each one keeps the full width of a PR column.
const STACK_FROM_ASPECT = 1.5;

export async function combine(before, afterCanvas, afterRatio) {
  const beforeBitmap = await createImageBitmap(before.blob);
  const scale = afterRatio / before.pixelRatio;
  const a = { width: beforeBitmap.width * scale, height: beforeBitmap.height * scale };
  const b = { width: afterCanvas.width, height: afterCanvas.height };

  const unit = afterRatio;
  const pad = PAD * unit;
  const gap = GAP * unit;
  const label = LABEL * unit;
  const minColumn = MIN_COLUMN * unit;
  const columnA = Math.max(a.width, minColumn);
  const columnB = Math.max(b.width, minColumn);

  const aspect = (a.width / a.height + b.width / b.height) / 2;
  const stacked = aspect >= STACK_FROM_ASPECT;
  const width = stacked ? pad * 2 + Math.max(columnA, columnB) : pad * 2 + columnA + gap + columnB;
  const height = stacked
    ? pad * 2 + label * 2 + a.height + gap + b.height
    : pad * 2 + label + Math.max(a.height, b.height);

  const fit = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = new OffscreenCanvas(Math.round(width * fit), Math.round(height * fit));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.scale(fit, fit);
  ctx.fillStyle = FRAME;
  ctx.fillRect(0, 0, width, height);

  ctx.font = `600 ${14 * unit}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = "middle";
  const draw = (image, size, text, color, x, y) => {
    ctx.fillStyle = color;
    ctx.fillText(text, x, y + label / 2 - 2 * unit);
    ctx.drawImage(image, x, y + label, size.width, size.height);
  };

  draw(beforeBitmap, a, "Before", BEFORE_LABEL, pad, pad);
  if (stacked) draw(afterCanvas, b, "After", AFTER_LABEL, pad, pad + label + a.height + gap);
  else draw(afterCanvas, b, "After", AFTER_LABEL, pad + columnA + gap, pad);
  beforeBitmap.close();

  return {
    canvas,
    pixelRatio: afterRatio * fit,
    notes: fit < 1 ? ["Resolution reduced to fit the maximum image size."] : [],
  };
}
