// Zips the extension into dist/framegrab-<version>.zip. Run with: npm run package
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "extension");
const { version } = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8"));
const zip = join(root, "dist", `framegrab-${version}.zip`);

mkdirSync(dirname(zip), { recursive: true });
rmSync(zip, { force: true });
execFileSync("zip", ["-qr", zip, ".", "-x", ".*"], { cwd: extension, stdio: "inherit" });
console.log(zip);
