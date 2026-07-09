#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const allowedFiles = new Set([
  "package.json",
  "bin/intellite.mjs",
  "README.md",
  "LICENSE",
  "package-lock.json",
  "SECURITY.md",
  ".gitignore",
  ".gitattributes",
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/publish.yml"
]);
const requiredPackageFields = [
  "name",
  "version",
  "description",
  "bin",
  "files",
  "license",
  "repository",
  "engines",
  "publishConfig"
];
const forbiddenPatterns = [
  /cfat_[A-Za-z0-9_-]+/g,
  /CLOUDFLARE_API_TOKEN\s*=/g,
  /SESSION_SECRET\s*=/g,
  /TURNSTILE_SECRET_KEY\s*=/g,
  /AUTH_EMAIL_API_TOKEN\s*=/g,
  /BROWSER_RUN_API_TOKEN\s*=/g,
  /INTELLITE_TOKEN\s*=/g,
  new RegExp("INTELLITE_" + "BASIC_AUTH", "g"),
  new RegExp("INTELLITE_" + "API_BASE_URL", "g"),
  new RegExp("m-" + "ohyama", "gi")
];

function fail(message) {
  console.error(`verify-package: ${message}`);
  process.exit(1);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function walk(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(fullPath));
    else result.push(fullPath);
  }
  return result;
}

const packageJson = readJson("package.json");

for (const field of requiredPackageFields) {
  if (!(field in packageJson)) fail(`package.json is missing ${field}.`);
}
if (packageJson.private) fail("package.json must not be private when publishing.");
if (packageJson.name !== "intellite") fail("package name must be intellite.");
if (packageJson.bin?.intellite !== "bin/intellite.mjs") fail("bin.intellite must point to bin/intellite.mjs.");
if (packageJson.license !== "SEE LICENSE IN LICENSE") fail("license must reference LICENSE.");
if (packageJson.repository?.url !== "git+https://github.com/Any010/intellite-cli.git") {
  fail("repository.url must match the GitHub repository used for npm trusted publishing.");
}
if (packageJson.publishConfig?.access !== "public") fail("publishConfig.access must be public.");

const files = walk(root).map((file) => path.relative(root, file).replace(/\\/g, "/"));
for (const file of files) {
  if (file.startsWith("scripts/")) continue;
  if (!allowedFiles.has(file)) fail(`unexpected file in CLI package directory: ${file}`);
}

for (const file of [...allowedFiles, "scripts/verify-package.mjs"]) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) fail(`required file is missing: ${file}`);
  const content = fs.readFileSync(fullPath, "utf8");
  for (const pattern of forbiddenPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) fail(`forbidden secret-like pattern found in ${file}: ${pattern}`);
  }
}

const cli = fs.readFileSync(path.join(root, "bin/intellite.mjs"), "utf8");
if (!cli.startsWith("#!/usr/bin/env node")) fail("CLI file must start with a node shebang.");
if (!cli.includes("https://intellite.app")) fail("CLI default base URL must be production Intellite.");
if (!cli.includes("https://intellite-staging.intellite.workers.dev")) fail("CLI staging environment must point to official Intellite staging.");
if (cli.includes("http://127.0.0.1:3200")) fail("CLI must not default to local development URL.");
if (cli.includes("\"cmd\"") || cli.includes("\"/c\", \"start\"")) fail("CLI must not open URLs through cmd start.");
if (cli.includes("process.env." + "INTELLITE_" + "API_BASE_URL")) fail("Public CLI must not support environment-selected API endpoints.");
if (cli.includes("process.env." + "INTELLITE_" + "BASIC_AUTH")) fail("Public CLI must not support Basic Auth gate credentials.");
if (!cli.includes("safeOutputFileName")) fail("CLI must sanitize server-provided output file names.");
if (!cli.includes("storeLocalToken")) fail("CLI must use the local credential storage abstraction.");
if (!cli.includes("windows-dpapi")) fail("CLI must support Windows DPAPI token storage.");
if (!cli.includes("macos-keychain")) fail("CLI must support macOS Keychain token storage.");
if (!cli.includes("linux-secret-service")) fail("CLI must support Linux Secret Service token storage.");
if (!cli.includes("INTELLITE_TOKEN_STORE=secure")) fail("CLI must document strict secure token storage mode.");
if (!cli.includes("INTELLITE_STAGING_TOKEN")) fail("CLI must support staging token override.");
if (!cli.includes("INTELLITE_AGENT_SKILLS_DIRS")) fail("CLI must support syncing additional local agent skill directories.");
if (!cli.includes("INTELLITE_SYNC_CODEX_SKILLS")) fail("CLI must support explicit Codex skill sync control.");
if (!cli.includes("config.staging.json")) fail("CLI must separate staging config from production config.");
if (!cli.includes("skills-staging")) fail("CLI must separate staging skills from production skills.");
if (!cli.includes("agent context")) fail("CLI must expose the current local agent context command.");
if (!cli.includes("app request-production-review")) fail("CLI must expose the production review request command.");
if (cli.includes("command === \"quote\"") || cli.includes("command === \"evidence\"")) fail("Base Intellite CLI must not expose app-specific commands.");
if (cli.includes("quote calculate") || cli.includes("quote create") || cli.includes("evidence create")) fail("Base Intellite CLI help must stay app-neutral.");
if (JSON.stringify(packageJson.keywords ?? []).toLowerCase().includes("quote")) fail("package keywords must stay app-neutral.");

console.log("verify-package: ok");
