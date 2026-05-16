#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const allowedTarballFiles = new Set(["LICENSE", "README.md", "bin/intellite.mjs", "package.json"]);
const maxTarballBytes = 100 * 1024;

function fail(message) {
  console.error(`verify-tarball: ${message}`);
  process.exit(1);
}

function parsePackJson(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) fail("npm pack did not return JSON output.");
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    fail("npm pack JSON output could not be parsed.");
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const result = spawnSync("npm", ["pack", "--json", "--dry-run"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  shell: process.platform === "win32"
});

if (result.status !== 0) {
  const output = `${result.stderr ?? ""}${result.stdout ?? ""}${result.error ? result.error.message : ""}`;
  fail(output || "npm pack --dry-run failed.");
}

const pack = parsePackJson(result.stdout ?? "");
if (!Array.isArray(pack) || pack.length !== 1) fail("npm pack must produce exactly one package.");

const manifest = pack[0];
if (manifest.name !== "intellite") fail(`unexpected package name: ${manifest.name}`);
if (manifest.version !== packageJson.version) fail("packed version does not match package.json.");
if (manifest.filename !== `intellite-${packageJson.version}.tgz`) fail(`unexpected tarball filename: ${manifest.filename}`);
if ((manifest.size ?? 0) <= 0 || manifest.size > maxTarballBytes) fail(`unexpected tarball size: ${manifest.size}`);
if (manifest.entryCount !== allowedTarballFiles.size) fail(`unexpected tarball entry count: ${manifest.entryCount}`);

const files = (manifest.files ?? []).map((file) => file.path).sort();
const expected = [...allowedTarballFiles].sort();
if (JSON.stringify(files) !== JSON.stringify(expected)) fail(`unexpected tarball files: ${files.join(", ")}`);

console.log(`verify-tarball: ok (${manifest.filename}, ${manifest.size} bytes)`);
