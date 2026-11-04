// Prepares a CalVer release: works out the version, writes it to the manifest and
// package files, and moves the Unreleased changelog entries under it.
//
// Versions are YYYY.M.MICRO, for example 2026.11.0. MICRO counts releases within
// the month from 0. Months aren't zero-padded because extension manifests reject
// numbers with leading zeros.
//
//   node scripts/release.mjs            apply the changes
//   node scripts/release.mjs --dry-run  only print the version and notes
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const TAG = /^v(\d{4})\.(\d{1,2})\.(\d+)$/;
const UNRELEASED = /^## Unreleased[ \t]*$/m;

export function nextVersion(tags, date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const micros = tags
    .map((tag) => TAG.exec(tag))
    .filter((match) => match && Number(match[1]) === year && Number(match[2]) === month)
    .map((match) => Number(match[3]));
  const micro = micros.length ? Math.max(...micros) + 1 : 0;
  return `${year}.${month}.${micro}`;
}

export function cutChangelog(text, version, date) {
  const heading = UNRELEASED.exec(text);
  if (!heading) throw new Error("CHANGELOG.md has no '## Unreleased' section.");
  const start = heading.index + heading[0].length;
  const rest = text.slice(start);
  const next = rest.search(/^## /m);
  const end = next === -1 ? rest.length : next;
  const notes = rest.slice(0, end).trim();
  if (!notes) throw new Error("Nothing to release: add entries under '## Unreleased' in CHANGELOG.md.");
  const day = date.toISOString().slice(0, 10);
  const after = rest.slice(end).trimStart();
  const changelog =
    `${text.slice(0, heading.index)}## Unreleased\n\n## ${version} - ${day}\n\n${notes}\n` +
    (after ? `\n${after}` : "");
  return { changelog, notes };
}

export function setManifestVersion(text, version) {
  // A plain replacement keeps the file's hand-written formatting.
  const updated = text.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`);
  if (updated === text && !text.includes(`"version": "${version}"`)) {
    throw new Error("manifest.json has no version field.");
  }
  return updated;
}

export function setPackageVersion(text, version) {
  const json = JSON.parse(text);
  json.version = version;
  if (json.packages?.[""]) json.packages[""].version = version;
  return `${JSON.stringify(json, null, 2)}\n`;
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const root = process.cwd();
  const date = new Date();
  const read = (file) => readFileSync(join(root, file), "utf8");
  const write = (file, text) => writeFileSync(join(root, file), text);

  const tags = execFileSync("git", ["tag", "--list", "v*"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const version = nextVersion(tags, date);
  const { changelog, notes } = cutChangelog(read("CHANGELOG.md"), version, date);

  if (dryRun) {
    console.log(`Next version: ${version}\n\n${notes}`);
    return;
  }

  write("CHANGELOG.md", changelog);
  write("extension/manifest.json", setManifestVersion(read("extension/manifest.json"), version));
  write("package.json", setPackageVersion(read("package.json"), version));
  write("package-lock.json", setPackageVersion(read("package-lock.json"), version));

  const notesFile = join(root, "dist", "release-notes.md");
  mkdirSync(dirname(notesFile), { recursive: true });
  writeFileSync(notesFile, `${notes}\n`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=v${version}\n`);
  }
  console.log(version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
