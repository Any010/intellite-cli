#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_BASE_URL = "https://intellite.app";
const CONFIG_DIR = path.join(os.homedir(), ".intellite");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const SKILLS_DIR = process.env.INTELLITE_SKILLS_DIR || path.join(CONFIG_DIR, "skills");
const MANAGED_SKILL_FILE = ".intellite-managed.json";
const TOKEN_SERVICE = "intellite-cli";
const TOKEN_ACCOUNT = "default";
const TOKEN_LABEL = "Intellite CLI token";
const DPAPI_TOKEN_FILE = path.join(CONFIG_DIR, "token.dpapi");
const DEFAULT_PERMISSIONS = [];
const MAX_JSON_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_SKILLS = 20;
const MAX_SKILL_FILES = 20;
const MAX_SKILL_FILE_BYTES = 256 * 1024;

function usage() {
  console.log(`intellite

Commands:
  login [--name NAME] [--permission APP_ID:CAPABILITY] [--force]
  status
  setup
  skills
  logout
  api METHOD PATH [--query KEY=VALUE] [--json JSON] [--body FILE]
  download PATH --output FILE

Environment:
  INTELLITE_TOKEN         Token override for ephemeral automation
  INTELLITE_TOKEN_STORE   auto, secure, or file
`);
}

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return fallback;
  return args[index + 1];
}

function withoutOptions(args, optionNames) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (optionNames.includes(args[index])) {
      index += 1;
      continue;
    }
    result.push(args[index]);
  }
  return result;
}

function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && index + 1 < args.length) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function queryEntries(args) {
  return optionValues(args, "--query").map((value) => {
    const raw = String(value || "");
    const separator = raw.indexOf("=");
    const key = (separator >= 0 ? raw.slice(0, separator) : raw).trim();
    const queryValue = separator >= 0 ? raw.slice(separator + 1) : "";
    if (!key) throw new Error("--query values must be KEY=VALUE.");
    return [key, queryValue];
  });
}

function withQueryParams(pathname, entries) {
  if (!entries.length) return pathname;
  const parsed = new URL(pathname, "https://intellite.local");
  for (const [key, value] of entries) parsed.searchParams.append(key, value);
  return `${parsed.pathname}${parsed.search}`;
}

function parsePermission(value) {
  const raw = String(value || "").trim();
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator >= raw.length - 1) return null;
  const appId = raw.slice(0, separator).trim();
  const capability = raw.slice(separator + 1).trim();
  if (!/^[a-z0-9][a-z0-9._:-]{0,79}$/.test(appId)) return null;
  if (!/^[a-z0-9][a-z0-9._:-]{0,159}$/.test(capability)) return null;
  return { appId, capability };
}

function requestedPermissions(args) {
  return optionValues(args, "--permission")
    .flatMap((value) => String(value).split(","))
    .map(parsePermission)
    .filter(Boolean);
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function sha256Base64url(value) {
  return base64url(crypto.createHash("sha256").update(value).digest());
}

function randomVerifier() {
  return crypto.randomBytes(48).toString("base64url");
}

async function readJsonFile(filePath) {
  const resolved = path.resolve(filePath);
  const stats = await fs.stat(resolved);
  if (stats.size > MAX_JSON_FILE_BYTES) {
    throw new Error(`${filePath} is too large. JSON input must be ${MAX_JSON_FILE_BYTES} bytes or smaller.`);
  }
  return parseJsonText(await fs.readFile(resolved, "utf8"), filePath);
}

function parseJsonText(value, source) {
  try {
    return JSON.parse(String(value).replace(/^\uFEFF/, ""));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`${source} is not valid JSON: ${detail}`);
  }
}

async function runProcess(command, args, { input = "", timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 1024 * 1024) child.kill();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error((stderr || stdout || `${command} exited with code ${code}`).trim()));
    });
    child.stdin.end(input);
  });
}

async function storeWindowsDpapiToken(token) {
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$plain = [Console]::In.ReadToEnd()",
    "$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)",
    "$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($protected))"
  ].join("; ");
  const encrypted = (await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { input: token })).trim();
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.chmod(CONFIG_DIR, 0o700).catch(() => null);
  await assertNotSymlink(DPAPI_TOKEN_FILE);
  await fs.writeFile(DPAPI_TOKEN_FILE, encrypted, { mode: 0o600 });
  await fs.chmod(DPAPI_TOKEN_FILE, 0o600).catch(() => null);
  return "windows-dpapi";
}

async function readWindowsDpapiToken() {
  const encrypted = await fs.readFile(DPAPI_TOKEN_FILE, "utf8");
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$b64 = [Console]::In.ReadToEnd()",
    "$protected = [Convert]::FromBase64String($b64)",
    "$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))"
  ].join("; ");
  return runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { input: encrypted.trim() });
}

async function storeMacKeychainToken(token) {
  await runProcess("security", ["add-generic-password", "-U", "-s", TOKEN_SERVICE, "-a", TOKEN_ACCOUNT, "-w", token]);
  return "macos-keychain";
}

async function readMacKeychainToken() {
  return (await runProcess("security", ["find-generic-password", "-s", TOKEN_SERVICE, "-a", TOKEN_ACCOUNT, "-w"])).trim();
}

async function storeLinuxSecretServiceToken(token) {
  await runProcess("secret-tool", ["store", "--label", TOKEN_LABEL, "service", TOKEN_SERVICE, "account", TOKEN_ACCOUNT], { input: token });
  return "linux-secret-service";
}

async function readLinuxSecretServiceToken() {
  return (await runProcess("secret-tool", ["lookup", "service", TOKEN_SERVICE, "account", TOKEN_ACCOUNT])).trim();
}

async function storeLocalToken(token) {
  const policy = (process.env.INTELLITE_TOKEN_STORE || "auto").toLowerCase();
  if (policy === "file") return null;
  const attempts = [];
  if (process.platform === "win32") attempts.push(storeWindowsDpapiToken);
  if (process.platform === "darwin") attempts.push(storeMacKeychainToken);
  if (process.platform === "linux") attempts.push(storeLinuxSecretServiceToken);
  for (const attempt of attempts) {
    try {
      return await attempt(token);
    } catch {
      // Fallback is handled below so login still works on minimal systems.
    }
  }
  if (policy === "secure") {
    throw new Error("No supported OS credential store is available. Set INTELLITE_TOKEN_STORE=file to allow file fallback.");
  }
  return null;
}

async function readLocalToken(tokenStore) {
  if (tokenStore === "windows-dpapi") return readWindowsDpapiToken();
  if (tokenStore === "macos-keychain") return readMacKeychainToken();
  if (tokenStore === "linux-secret-service") return readLinuxSecretServiceToken();
  return "";
}

async function clearLocalToken() {
  await fs.rm(DPAPI_TOKEN_FILE, { force: true }).catch(() => null);
  if (process.platform === "darwin") {
    await runProcess("security", ["delete-generic-password", "-s", TOKEN_SERVICE, "-a", TOKEN_ACCOUNT]).catch(() => null);
  }
  if (process.platform === "linux") {
    await runProcess("secret-tool", ["clear", "service", TOKEN_SERVICE, "account", TOKEN_ACCOUNT]).catch(() => null);
  }
}

async function readConfig() {
  if (process.env.INTELLITE_TOKEN) {
    return {
      token: process.env.INTELLITE_TOKEN
    };
  }
  try {
    const config = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
    if (config.tokenStore && config.tokenStore !== "file") {
      const token = await readLocalToken(config.tokenStore);
      if (token) return { ...config, token };
    }
    return config;
  } catch {
    return null;
  }
}

async function writeConfig(config) {
  const { token, ...metadata } = config;
  if (!token) throw new Error("Cannot save Intellite login without a token.");
  const tokenStore = await storeLocalToken(token);
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.chmod(CONFIG_DIR, 0o700).catch(() => null);
  await assertNotSymlink(CONFIG_FILE);
  const nextConfig = tokenStore ? { ...metadata, tokenStore } : { ...metadata, token, tokenStore: "file" };
  if (!tokenStore) {
    process.stderr.write(`Warning: secure OS credential store is unavailable. Token saved to ${CONFIG_FILE} with user-only file permissions. Set INTELLITE_TOKEN_STORE=secure to reject file fallback.\n`);
  }
  await fs.writeFile(CONFIG_FILE, JSON.stringify(nextConfig, null, 2), { mode: 0o600 });
  await fs.chmod(CONFIG_FILE, 0o600).catch(() => null);
}

async function clearConfig() {
  await clearLocalToken();
  await fs.rm(CONFIG_FILE, { force: true });
}

async function assertNotSymlink(filePath) {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${filePath}`);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function writeTextFileNoSymlink(filePath, content) {
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_FILE_BYTES) {
    throw new Error(`Skill file is too large: ${filePath}`);
  }
  await assertNotSymlink(filePath);
  await fs.writeFile(filePath, content, "utf8");
}

async function ensureDirectoryNoSymlink(dirPath, rootPath) {
  const resolvedDir = path.resolve(dirPath);
  const resolvedRoot = path.resolve(rootPath);
  const relative = path.relative(resolvedRoot, resolvedDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Directory is outside the managed skill root: ${dirPath}`);
  }
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    await assertNotSymlink(current);
    await fs.mkdir(current, { recursive: false }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
  }
}

function assertSafeSkillName(name) {
  const value = String(name || "");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error(`Invalid skill name from Intellite: ${value}`);
  return value;
}

function safeSkillFilePath(value) {
  const raw = String(value || "");
  if (!raw || path.isAbsolute(raw) || raw.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid skill file path from Intellite: ${raw}`);
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(raw)) {
    throw new Error(`Invalid skill file path from Intellite: ${raw}`);
  }
  return raw.replace(/\\/g, "/");
}

function localSkillsDir() {
  return path.resolve(SKILLS_DIR);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${DEFAULT_BASE_URL}${pathname}`, options);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json().catch(() => ({})) : await response.text();
  if (!response.ok) {
    const message = errorMessageFromBody(body, response.status);
    const error = new Error(String(message));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return { response, body };
}

function errorMessageFromBody(body, status) {
  const raw = typeof body === "object" && body && "error" in body ? body.error : body;
  if (!raw) return `HTTP ${status}`;
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return `HTTP ${status}`;
  }
}

function openBrowser(url) {
  const platform = process.platform;
  const command = platform === "win32" ? "rundll32.exe" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function login(args) {
  if (args.includes("--base-url")) {
    throw new Error("This CLI connects to https://intellite.app. Custom API endpoints are not supported in the public package.");
  }
  const force = args.includes("--force");
  const tokenFromEnv = Boolean(process.env.INTELLITE_TOKEN);
  const existingConfig = await readConfig();
  if (!force && existingConfig?.token) {
    try {
      const { body } = await authenticatedRequest("/api/intellite/status");
      const missingPermissions = await currentMissingPermissions();
      if (missingPermissions.length > 0) {
        console.log(`Existing login is valid, but app permissions changed. Re-approval is required for ${missingPermissions.length} permission(s).`);
      } else {
        console.log(`Already logged in: ${body.org?.name || body.org?.id || ""} / ${body.account?.name || body.account?.email || ""}`);
        await setupSkills({ quiet: false });
        return;
      }
    } catch (error) {
      if (tokenFromEnv) {
        throw new Error(`INTELLITE_TOKEN is set but could not be verified: ${error instanceof Error ? error.message : String(error)}`);
      }
      await clearConfig();
    }
  }
  const name = argValue(args, "--name", "AI assistant on this PC");
  const permissions = requestedPermissions(args);
  const previousToken = !tokenFromEnv && existingConfig?.token ? existingConfig.token : "";
  const codeVerifier = randomVerifier();
  const codeChallenge = sha256Base64url(codeVerifier);
  const { body } = await request("/api/intellite/device/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientName: name, codeChallenge, permissions: permissions.length ? permissions : DEFAULT_PERMISSIONS })
  });

  console.log(`Open this URL to authorize this PC:\n${body.verificationUriComplete}\n`);
  console.log(`Code: ${body.userCode}`);
  try {
    openBrowser(body.verificationUriComplete);
  } catch {
    // The URL above is enough when automatic browser opening is unavailable.
  }

  const intervalMs = Math.max(1, Number(body.intervalSeconds || 2)) * 1000;
  const expiresAt = Date.parse(body.expiresAt);
  while (Date.now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const response = await fetch(`${DEFAULT_BASE_URL}/api/intellite/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode: body.deviceCode, codeVerifier })
    });
    if (response.status === 202) {
      process.stdout.write(".");
      continue;
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (previousToken) await revokeToken(previousToken).catch(() => null);
    await writeConfig({
      token: result.token,
      expiresAt: result.expiresAt,
      apps: result.apps,
      account: result.account,
      org: result.org,
      createdAt: new Date().toISOString()
    });
    console.log(`\nLogged in: ${result.org?.name || result.org?.id || ""} / ${result.account?.name || result.account?.email || ""}`);
    try {
      await setupSkills({ quiet: false });
    } catch (error) {
      console.error(`Skill setup skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  throw new Error("Authorization timed out.");
}

async function authenticatedRequest(pathname, options = {}) {
  const config = await readConfig();
  if (!config?.token) throw new Error("Not logged in. Run `intellite login`.");
  return request(pathname, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "X-Intellite-Token": config.token
    }
  });
}

async function authenticatedFetch(pathname, options = {}) {
  const config = await readConfig();
  if (!config?.token) throw new Error("Not logged in. Run `intellite login`.");
  return fetch(`${DEFAULT_BASE_URL}${pathname}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "X-Intellite-Token": config.token
    }
  });
}

async function revokeToken(token) {
  if (!token) return;
  await request("/api/intellite/token/revoke", {
    method: "POST",
    headers: {
      "X-Intellite-Token": token
    }
  });
}

async function status() {
  const { body } = await authenticatedRequest("/api/intellite/status");
  console.log(JSON.stringify(body, null, 2));
}

async function fetchSkills() {
  const { body } = await authenticatedRequest("/api/intellite/skills");
  const skills = Array.isArray(body?.skills) ? body.skills : [];
  if (skills.length > MAX_SKILLS) throw new Error(`Too many skills returned by Intellite. Maximum is ${MAX_SKILLS}.`);
  return skills.map((skill) => ({
    name: assertSafeSkillName(skill.name),
    displayName: typeof skill.displayName === "string" ? skill.displayName : skill.name,
    description: typeof skill.description === "string" ? skill.description : "",
    version: typeof skill.version === "string" ? skill.version : "",
    appId: typeof skill.appId === "string" ? skill.appId : "",
    capabilities: Array.isArray(skill.capabilities) ? skill.capabilities.filter((item) => typeof item === "string") : [],
    requiredPermissions: normalizePermissionList(skill.requiredPermissions),
    grantedPermissions: normalizePermissionList(skill.grantedPermissions),
    files: (() => {
      const files = Array.isArray(skill.files) ? skill.files : [];
      if (files.length > MAX_SKILL_FILES) throw new Error(`Too many files returned for skill ${skill.name}. Maximum is ${MAX_SKILL_FILES}.`);
      return files.map((file) => ({
          path: safeSkillFilePath(file.path),
          content: typeof file.content === "string" ? file.content : ""
      }));
    })()
  }));
}

function permissionKey(permission) {
  return `${permission.appId}\u0000${permission.capability}`;
}

async function currentMissingPermissions() {
  const skills = await fetchSkills();
  const missing = [];
  for (const skill of skills) {
    const granted = new Set(skill.grantedPermissions.map(permissionKey));
    for (const permission of skill.requiredPermissions) {
      if (!granted.has(permissionKey(permission))) missing.push({ skill: skill.name, ...permission });
    }
  }
  return missing;
}

function normalizePermissionList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const appId = typeof item.appId === "string" ? item.appId : "";
      const capability = typeof item.capability === "string" ? item.capability : "";
      return appId && capability ? { appId, capability } : null;
    })
    .filter(Boolean);
}

async function managedSkillDirectories() {
  const root = localSkillsDir();
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const managed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const marker = JSON.parse(await fs.readFile(path.join(dir, MANAGED_SKILL_FILE), "utf8"));
      if (marker?.managedBy === "intellite" && marker?.name === entry.name) managed.push({ name: entry.name, dir });
    } catch {
      // Unmanaged skill directories are left untouched.
    }
  }
  return managed;
}

async function setupSkills({ quiet = false } = {}) {
  const skills = await fetchSkills();
  const root = localSkillsDir();
  await fs.mkdir(root, { recursive: true });
  const current = new Set(skills.map((skill) => skill.name));

  for (const skill of skills) {
    const skillDir = path.join(root, skill.name);
    const resolvedSkillDir = path.resolve(skillDir);
    await assertNotSymlink(skillDir);
    await fs.mkdir(skillDir, { recursive: true });
    for (const file of skill.files) {
      const target = path.resolve(skillDir, file.path);
      if (target !== resolvedSkillDir && !target.startsWith(`${resolvedSkillDir}${path.sep}`)) {
        throw new Error(`Invalid resolved skill file path from Intellite: ${file.path}`);
      }
      await ensureDirectoryNoSymlink(path.dirname(target), resolvedSkillDir);
      await writeTextFileNoSymlink(target, file.content);
    }
    await writeTextFileNoSymlink(
      path.join(skillDir, MANAGED_SKILL_FILE),
      JSON.stringify({ managedBy: "intellite", name: skill.name, version: skill.version, installedAt: new Date().toISOString() }, null, 2),
    );
  }

  for (const previous of await managedSkillDirectories()) {
    if (!current.has(previous.name)) await fs.rm(previous.dir, { recursive: true, force: true });
  }

  if (!quiet) {
    console.log(JSON.stringify({
      skillsDir: root,
      installed: skills.map((skill) => ({
        name: skill.name,
        version: skill.version,
        grantedPermissions: skill.grantedPermissions
      }))
    }, null, 2));
  }
  return skills;
}

async function listSkills() {
  const skills = await fetchSkills();
  console.log(JSON.stringify(skills.map((skill) => ({
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    version: skill.version,
    appId: skill.appId,
    capabilities: skill.capabilities,
    requiredPermissions: skill.requiredPermissions,
    grantedPermissions: skill.grantedPermissions
  })), null, 2));
}

async function logout() {
  const config = await readConfig();
  if (config?.token) {
    await authenticatedRequest("/api/intellite/token/revoke", { method: "POST" }).catch(() => null);
  }
  await clearConfig();
  console.log("Logged out.");
}

async function api(args) {
  const clean = withoutOptions(args, ["--json", "--body", "--query"]);
  const method = (clean[0] || "GET").toUpperCase();
  const pathname = withQueryParams(clean[1] || "", queryEntries(args));
  if (!pathname.startsWith("/")) throw new Error("API path must start with `/`.");
  const jsonArg = argValue(args, "--json", "");
  const bodyFile = argValue(args, "--body", "");
  const hasBody = jsonArg || bodyFile;
  const payload = jsonArg
    ? JSON.stringify(parseJsonText(jsonArg, "--json"))
    : bodyFile
      ? JSON.stringify(await readJsonFile(bodyFile))
      : undefined;
  const { body } = await authenticatedRequest(pathname, {
    method,
    headers: hasBody ? { "Content-Type": "application/json" } : {},
    body: payload
  });
  if (typeof body === "string") {
    console.log(body);
    return;
  }
  console.log(JSON.stringify(body, null, 2));
}

function fileNameFromDisposition(value, fallback) {
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value || "");
  if (utf8?.[1]) return decodeURIComponent(utf8[1]);
  const plain = /filename="?([^";]+)"?/i.exec(value || "");
  return plain?.[1] || fallback;
}

function safeOutputFileName(value, fallback) {
  const baseName = path.basename(String(value || fallback)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return baseName && baseName !== "." && baseName !== ".." ? baseName : fallback;
}

async function download(args) {
  const pathname = args[0] || "";
  if (!pathname || !pathname.startsWith("/")) throw new Error("Usage: intellite download PATH --output FILE");
  const outputArg = argValue(args, "--output", "");
  const response = await authenticatedFetch(pathname);
  if (!response.ok) {
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await response.json().catch(() => ({})) : await response.text();
    const message = errorMessageFromBody(body, response.status);
    throw new Error(String(message));
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Download response is too large. Maximum is ${MAX_DOWNLOAD_BYTES} bytes.`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Download response is too large. Maximum is ${MAX_DOWNLOAD_BYTES} bytes.`);
  }
  const fallback = safeOutputFileName(path.basename(new URL(`https://intellite.local${pathname}`).pathname), "download.bin");
  const fileName = outputArg || safeOutputFileName(fileNameFromDisposition(response.headers.get("content-disposition"), fallback), fallback);
  const filePath = path.resolve(fileName);
  await fs.writeFile(filePath, buffer);
  console.log(JSON.stringify({
    path: pathname,
    filePath,
    bytes: buffer.byteLength,
    contentType: response.headers.get("content-type") || ""
  }, null, 2));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "login") return login(args);
  if (command === "status") return status();
  if (command === "setup") return setupSkills();
  if (command === "skills") return listSkills();
  if (command === "logout") return logout();
  if (command === "api") return api(args);
  if (command === "download") return download(args);
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
