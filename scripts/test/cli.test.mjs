import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// All tests run the CLI as a subprocess with HOME/USERPROFILE pointed at a
// throwaway directory, so nothing touches the real ~/.intellite. Every test
// exercises a code path that fails or finishes before any fetch() call, so
// no network access ever happens.

const CLI_PATH = fileURLToPath(new URL("../../bin/intellite.mjs", import.meta.url));
const RUN_TIMEOUT_MS = 30000;

async function makeTempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "intellite-cli-test-"));
}

async function removeTempHome(home) {
  await fs.rm(home, { recursive: true, force: true });
}

function runCli(args, { home, env = {} } = {}) {
  const childEnv = { ...process.env, ...env };
  // Never inherit real credentials or overrides from the host machine.
  delete childEnv.INTELLITE_TOKEN;
  delete childEnv.INTELLITE_STAGING_TOKEN;
  delete childEnv.INTELLITE_SKILLS_DIR;
  delete childEnv.INTELLITE_STAGING_SKILLS_DIR;
  delete childEnv.INTELLITE_TOKEN_STORE;
  Object.assign(childEnv, env);
  if (home) {
    childEnv.HOME = home;
    childEnv.USERPROFILE = home;
  }
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI_PATH, ...args],
      { env: childEnv, timeout: RUN_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error ? error.code : 0, stdout, stderr });
      }
    );
  });
}

async function withTempHome(fn) {
  const home = await makeTempHome();
  try {
    return await fn(home);
  } finally {
    await removeTempHome(home);
  }
}

function configDir(home) {
  return path.join(home, ".intellite");
}

async function writeConfigFile(home, fileName, value) {
  const dir = configDir(home);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
  return filePath;
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// --- help / usage ---------------------------------------------------------

test("help command prints usage and exits 0", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["help"], { home });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Commands:/);
    assert.match(result.stdout, /login \[--name NAME\]/);
    assert.match(result.stdout, /agent setup/);
    assert.match(result.stdout, /agent context/);
    assert.match(result.stdout, /api METHOD PATH/);
    assert.match(result.stdout, /download PATH \[--output FILE\]/);
    assert.match(result.stdout, /app request-production-review \[FILE\]/);
    assert.match(result.stdout, /--env production\|staging/);
    assert.match(result.stdout, /INTELLITE_AGENT_SKILLS_DIRS/);
    assert.match(result.stdout, /INTELLITE_TOKEN_STORE/);
  });
});

test("agent help prints the supported local agent surface", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["agent", "--help"], { home });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /intellite agent/);
    assert.match(result.stdout, /agent setup/);
    assert.match(result.stdout, /agent context/);
    assert.match(result.stdout, /agent api METHOD PATH/);
    assert.match(result.stdout, /agent download PATH \[--output FILE\]/);
  });
});

test("app help prints developer app commands", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["app", "--help"], { home });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /intellite app/);
    assert.match(result.stdout, /app init/);
    assert.match(result.stdout, /app validate/);
    assert.match(result.stdout, /app conformance/);
    assert.match(result.stdout, /app publish \[FILE\] --app-env staging/);
    assert.match(result.stdout, /app request-production-review \[FILE\]/);
  });
});

// --- developer app manifest checks ------------------------------------------

test("app init scaffolds the current schema v2 manifest and validates offline", async () => {
  await withTempHome(async (home) => {
    const manifestPath = path.join(home, "intellite.app.json");
    const init = await runCli(["app", "init", "--output", manifestPath], { home });
    assert.equal(init.code, 0);

    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.equal(manifest.schemaVersion, 2);
    assert.ok(Array.isArray(manifest.resources), "schema v2 sample should include resources");
    assert.ok(Array.isArray(manifest.actions), "schema v2 sample should include actions");
    assert.ok(Array.isArray(manifest.events), "schema v2 sample should include events");

    const validate = await runCli(["app", "validate", manifestPath], { home });
    assert.equal(validate.code, 0);
    const body = JSON.parse(validate.stdout);
    assert.equal(body.ok, true);
  });
});

test("app validate accepts unsigned skills with a warning because publish signs them server-side", async () => {
  await withTempHome(async (home) => {
    const manifestPath = path.join(home, "unsigned-skill.app.json");
    const init = await runCli(["app", "init", "--output", manifestPath], { home });
    assert.equal(init.code, 0);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    delete manifest.skills[0].signature;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const validate = await runCli(["app", "validate", manifestPath], { home });
    assert.equal(validate.code, 0);
    const body = JSON.parse(validate.stdout);
    assert.equal(body.ok, true);
    assert.match(JSON.stringify(body.warnings), /signs unsigned skills/);
  });
});

test("app validate rejects root catch-all routes", async () => {
  await withTempHome(async (home) => {
    const manifestPath = path.join(home, "catchall.app.json");
    const init = await runCli(["app", "init", "--output", manifestPath], { home });
    assert.equal(init.code, 0);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.proxyRoutes[0].publicPathPattern = "^/.*";
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const validate = await runCli(["app", "validate", manifestPath], { home });
    assert.equal(validate.code, 1);
    const body = JSON.parse(validate.stdout);
    assert.equal(body.ok, false);
    assert.match(JSON.stringify(body.errors), /root catch-all/);
  });
});

test("app validate rejects high-risk automatic actions", async () => {
  await withTempHome(async (home) => {
    const manifestPath = path.join(home, "dangerous-action.app.json");
    const init = await runCli(["app", "init", "--output", manifestPath], { home });
    assert.equal(init.code, 0);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.actions[0].risk = "external_send";
    manifest.actions[0].approval = "auto";
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const validate = await runCli(["app", "validate", manifestPath], { home });
    assert.equal(validate.code, 1);
    const body = JSON.parse(validate.stdout);
    assert.equal(body.ok, false);
    assert.match(JSON.stringify(body.errors), /High-risk actions/);
  });
});

test("app call tickets preserve identity headers without forwarding internal service headers", async () => {
  const cli = await fs.readFile(CLI_PATH, "utf8");
  assert.match(cli, /APP_TICKET_HEADER_ALLOWLIST/);
  assert.match(cli, /"x-pages-user-email"/);
  assert.match(cli, /"x-pages-identity-signature"/);
  assert.doesNotMatch(cli, /"x-rpa-internal-api-call"/);
  assert.doesNotMatch(cli, /"x-rpa-internal-user-email"/);
});

test("no command prints usage and exits 0", async () => {
  await withTempHome(async (home) => {
    const result = await runCli([], { home });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Commands:/);
  });
});

test("--help and -h print usage and exit 0", async () => {
  await withTempHome(async (home) => {
    for (const flag of ["--help", "-h"]) {
      const result = await runCli([flag], { home });
      assert.equal(result.code, 0, `${flag} should exit 0`);
      assert.match(result.stdout, /Commands:/);
    }
  });
});

test("unknown command exits 1 with an error message", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["frobnicate"], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown command: frobnicate/);
  });
});

// --- --env global option --------------------------------------------------

test("--env with an unknown environment exits 1", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["--env", "bogus", "status"], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown environment: bogus/);
  });
});

test("--env without a value exits 1", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["status", "--env"], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--env requires production or staging\./);
  });
});

test("--env staging changes the login hint to the staging command", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["--env", "staging", "status"], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Not logged in\. Run `intellite --env staging login`\./);
  });
});

test("--env=staging (equals form) is accepted", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["--env=staging", "status"], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /intellite --env staging login/);
  });
});

test("--env prod is an alias for production", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["--env", "prod", "status"], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Not logged in\. Run `intellite login`\./);
  });
});

// --- commands that require a token refuse to run when logged out -----------

for (const command of [
  ["status"],
  ["setup"],
  ["skills"],
  ["api", "GET", "/api/intellite/status"],
  ["download", "/api/intellite/file"],
  ["agent", "setup"],
  ["agent", "status"],
  ["agent", "skills"],
  ["agent", "context"],
  ["agent", "api", "GET", "/api/intellite/apps/example/workspace"],
  ["agent", "download", "/api/intellite/apps/example/file"]
]) {
  test(`${command[0]} without a token exits 1 with a login hint (${command.join(" ")})`, async () => {
    await withTempHome(async (home) => {
      const result = await runCli(command, { home });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Not logged in\. Run `intellite login`\./);
    });
  });
}

test("a config with tokenStore=file but no token is treated as logged out", async () => {
  await withTempHome(async (home) => {
    await writeConfigFile(home, "config.json", { tokenStore: "file", createdAt: "2026-01-01T00:00:00.000Z" });
    const result = await runCli(["status"], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Not logged in\./);
  });
});

test("a config pointing at a missing DPAPI token file is treated as logged out", async () => {
  await withTempHome(async (home) => {
    await writeConfigFile(home, "config.json", { tokenStore: "windows-dpapi" });
    const result = await runCli(["status"], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Not logged in\./);
  });
});

test("a corrupt config file is treated as logged out", async () => {
  await withTempHome(async (home) => {
    await writeConfigFile(home, "config.json", "{ not json");
    const result = await runCli(["status"], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Not logged in\./);
  });
});

// --- login argument validation (fails before any network use) --------------

test("login --base-url is rejected", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["login", "--base-url", "https://evil.example"], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Custom API endpoints are not supported\. Use --env production or --env staging\./);
  });
});

// --- api argument parsing ---------------------------------------------------

test("api rejects paths that do not start with /", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["api", "GET", "api/intellite/status"], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /API path must start with `\/`\./);
  });
});

test("api rejects invalid --json payloads", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["api", "POST", "/api/x", "--json", "{not-json"], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--json is not valid JSON/);
  });
});

test("api rejects --query values without a key", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["api", "GET", "/api/x", "--query", "=value"], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--query values must be KEY=VALUE\./);
  });
});

test("api accepts --query KEY=VALUE and proceeds to the auth check", async () => {
  await withTempHome(async (home) => {
    // With no token stored, a valid query still stops at the login check,
    // proving parsing succeeded without any network call.
    const result = await runCli(["api", "GET", "/api/x", "--query", "limit=5", "--query", "flag="], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Not logged in\./);
  });
});

test("api reports a missing --body file", async () => {
  await withTempHome(async (home) => {
    const missing = path.join(home, "does-not-exist.json");
    const result = await runCli(["api", "POST", "/api/x", "--body", missing], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /ENOENT|no such file/i);
  });
});

test("api rejects --body files above the size limit", async () => {
  await withTempHome(async (home) => {
    const big = path.join(home, "big.json");
    await fs.writeFile(big, Buffer.alloc(5 * 1024 * 1024 + 1, 0x20));
    const result = await runCli(["api", "POST", "/api/x", "--body", big], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /too large/);
  });
});

test("api rejects --body files that are not valid JSON", async () => {
  await withTempHome(async (home) => {
    const bodyFile = path.join(home, "body.json");
    await fs.writeFile(bodyFile, "definitely not json", "utf8");
    const result = await runCli(["api", "POST", "/api/x", "--body", bodyFile], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /is not valid JSON/);
  });
});

// --- download argument parsing ----------------------------------------------

test("download without a path prints usage error", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["download"], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage: intellite download PATH --output FILE/);
  });
});

test("download rejects paths that do not start with /", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["download", "files/report.pdf"], { home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage: intellite download PATH --output FILE/);
  });
});

// --- logout and per-environment config files --------------------------------

test("logout with no saved login succeeds", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["logout"], { home });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Logged out\./);
  });
});

test("logout removes production config and DPAPI file but leaves staging files", async () => {
  await withTempHome(async (home) => {
    // Token-less configs keep logout fully offline (no revoke request).
    const prodConfig = await writeConfigFile(home, "config.json", { tokenStore: "file" });
    const stagingConfig = await writeConfigFile(home, "config.staging.json", { tokenStore: "file" });
    const prodDpapi = await writeConfigFile(home, "token.dpapi", "fake-encrypted-token");
    const stagingDpapi = await writeConfigFile(home, "token.staging.dpapi", "fake-encrypted-token");

    const result = await runCli(["logout"], { home });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Logged out\./);

    assert.equal(await fileExists(prodConfig), false, "production config should be removed");
    assert.equal(await fileExists(prodDpapi), false, "production DPAPI token file should be removed");
    assert.equal(await fileExists(stagingConfig), true, "staging config must remain untouched");
    assert.equal(await fileExists(stagingDpapi), true, "staging DPAPI token file must remain untouched");
  });
});

test("--env staging logout removes staging files but leaves production files", async () => {
  await withTempHome(async (home) => {
    const prodConfig = await writeConfigFile(home, "config.json", { tokenStore: "file" });
    const stagingConfig = await writeConfigFile(home, "config.staging.json", { tokenStore: "file" });
    const prodDpapi = await writeConfigFile(home, "token.dpapi", "fake-encrypted-token");
    const stagingDpapi = await writeConfigFile(home, "token.staging.dpapi", "fake-encrypted-token");

    const result = await runCli(["--env", "staging", "logout"], { home });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Logged out\./);

    assert.equal(await fileExists(stagingConfig), false, "staging config should be removed");
    assert.equal(await fileExists(stagingDpapi), false, "staging DPAPI token file should be removed");
    assert.equal(await fileExists(prodConfig), true, "production config must remain untouched");
    assert.equal(await fileExists(prodDpapi), true, "production DPAPI token file must remain untouched");
  });
});

test("global --env option is extracted even when placed after the command", async () => {
  await withTempHome(async (home) => {
    const stagingConfig = await writeConfigFile(home, "config.staging.json", { tokenStore: "file" });
    const result = await runCli(["logout", "--env", "staging"], { home });
    assert.equal(result.code, 0);
    assert.equal(await fileExists(stagingConfig), false, "staging config should be removed");
  });
});
