#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const version = process.argv[2] || packageJson.version;
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid package version: ${version}`);
}
const prefix = await fs.mkdtemp(path.join(os.tmpdir(), "intellite-published-"));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: prefix,
      shell: false,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stdout}\n${stderr}`));
    });
  });
}

try {
  const command = process.platform === "win32" ? "cmd.exe" : "npx";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npx", "--prefix", prefix, "--yes", `intellite@${version}`, "help"]
    : ["--prefix", prefix, "--yes", `intellite@${version}`, "help"];
  const { stdout } = await run(command, args);
  if (!stdout.includes("intellite") || !stdout.includes("INTELLITE_TOKEN_STORE")) {
    throw new Error("Published CLI help output did not match the expected Intellite CLI.");
  }
  console.log(`verify-published: ok (intellite@${version})`);
} finally {
  await fs.rm(prefix, { recursive: true, force: true }).catch(() => null);
}
