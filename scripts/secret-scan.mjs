#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const ignoredDirectories = new Set([".git", "node_modules", "coverage", "dist"]);
const ignoredFiles = new Set(["package-lock.json"]);
const patterns = [
  { name: "Cloudflare API token", regex: /cf[a-z]_[A-Za-z0-9_-]{20,}/g },
  { name: "npm token", regex: /npm_[A-Za-z0-9]{20,}/g },
  { name: "GitHub token", regex: /gh[pousr]_[A-Za-z0-9_]{20,}/g },
  { name: "OpenAI API key", regex: /sk-[A-Za-z0-9]{20,}/g },
  { name: "AWS access key", regex: /AKIA[0-9A-Z]{16}/g },
  { name: "private key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g }
];

function walk(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(fullPath));
    else result.push(fullPath);
  }
  return result;
}

let failed = false;
for (const file of walk(root)) {
  const relative = path.relative(root, file).replace(/\\/g, "/");
  if (ignoredFiles.has(relative) || relative.endsWith(".tgz")) continue;
  const content = fs.readFileSync(file, "utf8");
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(content)) {
      console.error(`secret-scan: ${pattern.name} pattern found in ${relative}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("secret-scan: ok");
