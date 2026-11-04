import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cutChangelog, nextVersion, setManifestVersion, setPackageVersion } from "../scripts/release.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOV = new Date("2026-11-04T12:00:00Z");

test("first release of a month starts at micro 0", () => {
  assert.equal(nextVersion([], NOV), "2026.11.0");
  assert.equal(nextVersion(["v2026.10.7"], NOV), "2026.11.0");
  assert.equal(nextVersion(["v2025.11.3"], NOV), "2026.11.0");
});

test("later releases in a month count up numerically", () => {
  assert.equal(nextVersion(["v2026.11.0"], NOV), "2026.11.1");
  assert.equal(nextVersion(["v2026.11.9", "v2026.11.10", "v2026.11.2"], NOV), "2026.11.11");
});

test("tags that aren't CalVer releases are ignored", () => {
  assert.equal(nextVersion(["v1.2.0", "v2026.11", "v2026.11.5-rc1", "nightly"], NOV), "2026.11.0");
});

test("the month comes from UTC and is never zero-padded", () => {
  assert.equal(nextVersion([], new Date("2027-02-28T23:59:59Z")), "2027.2.0");
  assert.equal(nextVersion([], new Date("2027-01-01T00:00:00Z")), "2027.1.0");
});

test("generated versions are valid manifest versions", () => {
  // The rules from Chrome's manifest documentation.
  for (const date of ["2026-01-15", "2026-09-15", "2026-12-15"]) {
    for (const tags of [[], ["v2026.1.0", "v2026.9.0", "v2026.12.0"]]) {
      const parts = nextVersion(tags, new Date(`${date}T00:00:00Z`)).split(".");
      assert.ok(parts.length >= 1 && parts.length <= 4);
      for (const part of parts) {
        assert.match(part, /^(0|[1-9]\d*)$/);
        assert.ok(Number(part) <= 65535);
      }
    }
  }
});

const CHANGELOG = `# Changelog

Intro text.

## Unreleased

### Added

- New thing

## 2026.10.0 - 2026-10-01

### Fixed

- Old thing
`;

test("changelog entries move under the new version", () => {
  const { changelog, notes } = cutChangelog(CHANGELOG, "2026.11.0", NOV);
  assert.equal(notes, "### Added\n\n- New thing");
  assert.equal(
    changelog,
    `# Changelog

Intro text.

## Unreleased

## 2026.11.0 - 2026-11-04

### Added

- New thing

## 2026.10.0 - 2026-10-01

### Fixed

- Old thing
`,
  );
});

test("the first release works with no earlier versions", () => {
  const { changelog } = cutChangelog("# Changelog\n\n## Unreleased\n\n- First\n", "2026.11.0", NOV);
  assert.equal(changelog, "# Changelog\n\n## Unreleased\n\n## 2026.11.0 - 2026-11-04\n\n- First\n");
});

test("a release with nothing to log is refused", () => {
  assert.throws(() => cutChangelog("# Changelog\n\n## Unreleased\n\n## 2026.10.0 - 2026-10-01\n\n- Old\n", "2026.11.0", NOV), /Nothing to release/);
  assert.throws(() => cutChangelog("# Changelog\n", "2026.11.0", NOV), /no '## Unreleased'/);
});

test("manifest formatting is preserved", () => {
  const manifest = `{\n  "manifest_version": 3,\n  "version": "1.2.0",\n  "action": { "default_title": "x" }\n}\n`;
  assert.equal(setManifestVersion(manifest, "2026.11.0"), manifest.replace("1.2.0", "2026.11.0"));
});

test("package-lock versions are both updated, dependencies aren't", () => {
  const lock = JSON.stringify({
    name: "x",
    version: "1.0.0",
    packages: { "": { version: "1.0.0" }, "node_modules/y": { version: "9.9.9" } },
  });
  const updated = JSON.parse(setPackageVersion(lock, "2026.11.0"));
  assert.equal(updated.version, "2026.11.0");
  assert.equal(updated.packages[""].version, "2026.11.0");
  assert.equal(updated.packages["node_modules/y"].version, "9.9.9");
});

test("the script updates a real checkout and reports the version", () => {
  const dir = mkdtempSync(join(tmpdir(), "framegrab-release-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    mkdirSync(join(dir, "extension"));
    for (const file of ["package.json", "package-lock.json", "extension/manifest.json"]) {
      writeFileSync(join(dir, file), readFileSync(join(ROOT, file)));
    }
    writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "x");

    const year = new Date().getUTCFullYear();
    const month = new Date().getUTCMonth() + 1;
    git("tag", `v${year}.${month}.4`);

    const script = join(ROOT, "scripts", "release.mjs");
    const preview = spawnSync(process.execPath, [script, "--dry-run"], { cwd: dir, encoding: "utf8" });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, new RegExp(`Next version: ${year}\\.${month}\\.5`));
    assert.equal(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), CHANGELOG, "a dry run changes nothing");

    const outputFile = join(dir, "output.txt");
    const run = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
    });
    assert.equal(run.status, 0, run.stderr);
    const version = `${year}.${month}.5`;
    assert.equal(readFileSync(outputFile, "utf8"), `version=${version}\ntag=v${version}\n`);
    assert.equal(JSON.parse(readFileSync(join(dir, "extension/manifest.json"), "utf8")).version, version);
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, version);
    assert.equal(JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")).version, version);
    assert.equal(readFileSync(join(dir, "dist/release-notes.md"), "utf8"), "### Added\n\n- New thing\n");

    // Nothing left under Unreleased, so a second run must refuse.
    const again = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /Nothing to release/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the repo's changelog is ready for a release", () => {
  const text = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  assert.match(text, /^## Unreleased$/m);
});
