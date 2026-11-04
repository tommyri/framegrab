// Renders extension/icons from the SVGs in assets. Run with: npm run icons
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "extension", "icons");
mkdirSync(out, { recursive: true });

const source = (name) => readFileSync(join(root, "assets", name), "utf8");

// The small sizes use a heavier drawing that stays legible in the toolbar.
// Inset is transparent padding: the Chrome Web Store expects 96 px of artwork
// inside the 128 px icon.
const SIZES = [
  { size: 16, svg: "icon-small.svg", inset: 0 },
  { size: 32, svg: "icon-small.svg", inset: 0 },
  { size: 48, svg: "icon.svg", inset: 2 },
  { size: 128, svg: "icon.svg", inset: 16 },
];

const browser = await chromium.launch();
for (const { size, svg, inset } of SIZES) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const art = size - inset * 2;
  await page.setContent(`<!doctype html><body style="margin:0;background:transparent">
    <div style="position:absolute;left:${inset}px;top:${inset}px;width:${art}px;height:${art}px">${source(svg)}</div>
  </body>`);
  await page.screenshot({ path: join(out, `${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
