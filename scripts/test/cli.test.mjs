import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    assert.match(result.stdout, /app adopt/);
    assert.match(result.stdout, /app probe/);
    assert.match(result.stdout, /--env production\|staging/);
    assert.match(result.stdout, /INTELLITE_AGENT_SKILLS_DIRS/);
    assert.match(result.stdout, /INTELLITE_TOKEN_STORE/);
  });
});

test("version command prints the package version", async () => {
  await withTempHome(async (home) => {
    const packageJson = JSON.parse(await fs.readFile(path.join(path.dirname(CLI_PATH), "..", "package.json"), "utf8"));
    const result = await runCli(["--version"], { home });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), packageJson.version);
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
    assert.match(result.stdout, /app adopt/);
    assert.match(result.stdout, /app validate/);
    assert.match(result.stdout, /app conformance/);
    assert.match(result.stdout, /app refresh/);
    assert.match(result.stdout, /app doctor/);
    assert.match(result.stdout, /app probe/);
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

    const guidancePath = path.join(home, ".intellite", "agent-guidance.md");
    const usageGuideExamplePath = path.join(home, ".intellite", "examples", "usage-guide.md");
    const signatureExamplePath = path.join(home, ".intellite", "examples", "proxy-signature-verification.md");
    const oauthExamplePath = path.join(home, ".intellite", "examples", "oauth-connection.md");
    const verifierPath = path.join(home, "intellite", "intellite-proxy.mjs");
    const oauthPath = path.join(home, "intellite", "intellite-oauth.mjs");
    const lockPath = path.join(home, ".intellite", "guidance-lock.json");
    assert.match(await fs.readFile(guidancePath, "utf8"), /Intellite App Agent Guidance/);
    assert.match(await fs.readFile(usageGuideExamplePath, "utf8"), /Usage Guide Endpoint Example/);
    const signatureExample = await fs.readFile(signatureExamplePath, "utf8");
    assert.match(signatureExample, /Intellite Proxy Signature Verification Example/);
    assert.match(signatureExample, /X-Intellite-Proxy-Signature/);
    assert.match(signatureExample, /ES256/);
    assert.match(await fs.readFile(oauthExamplePath, "utf8"), /Existing-App OAuth Connection/);
    const verifier = await fs.readFile(verifierPath, "utf8");
    assert.match(verifier, /verifyIntelliteProxyRequest/);
    assert.match(verifier, /intellite-app-proxy/);
    const oauthAdapter = await fs.readFile(oauthPath, "utf8");
    assert.match(oauthAdapter, /createIntelliteConnectionRequest/);
    assert.match(oauthAdapter, /completeIntelliteConnectionCallback/);
    const guidanceLock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assert.equal(guidanceLock.kind, "app-guidance");
    assert.ok(Object.values(guidanceLock.files).every((entry) => typeof entry.fingerprint === "string" && entry.fingerprint.length > 0));
    assert.equal(await fileExists(path.join(home, ".codex")), false, "app init must not install global Codex skills");

    const validate = await runCli(["app", "validate", manifestPath], { home });
    assert.equal(validate.code, 0);
    const body = JSON.parse(validate.stdout);
    assert.equal(body.ok, true);

    const sampleDoctor = await runCli(["app", "doctor", manifestPath], { home });
    assert.equal(sampleDoctor.code, 1);
    const sampleDoctorBody = JSON.parse(sampleDoctor.stdout);
    assert.equal(sampleDoctorBody.ok, false);
    assert.match(JSON.stringify(sampleDoctorBody.checks), /replace-sample-app-id/);

    const readyManifest = JSON.parse(
      JSON.stringify(manifest)
        .replaceAll("example-workflow", "acme-workflow")
        .replaceAll("Example Workflow", "Acme Workflow")
        .replaceAll("staging.example-app.example.com", "staging.acme.example.net")
        .replaceAll("example-app.example.com", "acme.example.net")
    );
    await fs.writeFile(manifestPath, JSON.stringify(readyManifest, null, 2), "utf8");
    const refresh = await runCli(["app", "refresh", manifestPath], { home });
    assert.equal(refresh.code, 0);
    const generatedOnlyDoctor = await runCli(["app", "doctor", manifestPath], { home });
    assert.equal(generatedOnlyDoctor.code, 1);
    assert.match(JSON.stringify(JSON.parse(generatedOnlyDoctor.stdout).checks), /implementation:oauth-connection/);
    await fs.mkdir(path.join(home, "src"), { recursive: true });
    await fs.writeFile(path.join(home, "src", "intellite-route.mjs"), `
import { authorizeIntelliteProxyRequest } from "../intellite/intellite-proxy.mjs";
import { createIntelliteConnectionRequest, completeIntelliteConnectionCallback } from "../intellite/intellite-oauth.mjs";
const transactionStore = { async create() { return true; }, async consume() { return null; } };
const connectionStore = {
  async findOrganizationLink() { return { status: "active", localTenantId: "tenant-1" }; },
  async findUserLink() { return { status: "active", localTenantId: "tenant-1", localUserId: "user-1" }; }
};
export async function usageGuide(request) {
  await authorizeIntelliteProxyRequest(request, {
    requiredCapability: "acme-workflow.read",
    jwksUrl: process.env.INTELLITE_JWKS_URL,
    connectionStore,
    authorizeLocalAccess: async () => true
  });
  return new Response("usage-guide");
}
export async function connect(options) { return createIntelliteConnectionRequest({ ...options, transactionStore }); }
export async function callback(options) {
  return completeIntelliteConnectionCallback({ ...options, transactionStore, authorizeLocalActor: async () => true });
}
`, "utf8");
    const doctor = await runCli(["app", "doctor", manifestPath], { home });
    assert.equal(doctor.code, 0);
    const doctorBody = JSON.parse(doctor.stdout);
    assert.equal(doctorBody.ok, true);
    assert.equal(doctorBody.localReady, true);
    assert.equal(doctorBody.runtimeReady, false);
    assert.match(JSON.stringify(doctorBody.implementationEvidenceFiles), /src\/intellite-route.mjs/);
  });
});

test("app adopt detects an existing framework without exposing detected business routes", async () => {
  await withTempHome(async (home) => {
    await fs.writeFile(path.join(home, "package.json"), JSON.stringify({
      name: "@acme/order-console",
      dependencies: { express: "^4.0.0" }
    }), "utf8");
    await fs.mkdir(path.join(home, "src"), { recursive: true });
    await fs.writeFile(path.join(home, "src", "app.js"), `
app.get("/api/orders", listOrders);
app.post("/api/orders", createOrder);
`, "utf8");

    const manifestPath = path.join(home, "intellite.app.json");
    const adopt = await runCli([
      "app", "adopt",
      "--output", manifestPath,
      "--staging-url", "https://staging.orders.example.net",
      "--production-url", "https://orders.example.net"
    ], { home });
    assert.equal(adopt.code, 0);
    const body = JSON.parse(adopt.stdout);
    assert.equal(body.appId, "order-console");
    assert.equal(body.framework, "express");
    assert.equal(body.routeCandidateCount, 2);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.equal(manifest.proxyRoutes.length, 1);
    assert.equal(manifest.proxyRoutes[0].routeId, "usage-guide-read");
    assert.equal(manifest.environments.production.oauthRedirectUris[0], "https://orders.example.net/api/auth/intellite/callback");
    assert.match(await fs.readFile(path.join(home, "intellite", "intellite-oauth.mjs"), "utf8"), /transactionStore/);
    const report = JSON.parse(await fs.readFile(path.join(home, ".intellite", "adoption-report.json"), "utf8"));
    assert.equal(report.automaticExposure.length, 0);
    assert.deepEqual(report.routeCandidates.map((route) => route.path).sort(), ["/api/orders", "/api/orders"]);
  });
});

test("generated external app verifier accepts valid ES256 and rejects tampering", async () => {
  await withTempHome(async (home) => {
    const manifestPath = path.join(home, "intellite.app.json");
    const init = await runCli(["app", "init", "--output", manifestPath], { home });
    assert.equal(init.code, 0);
    const verifierPath = path.join(home, "intellite", "intellite-proxy.mjs");
    const verifier = await import(`${pathToFileURL(verifierPath).href}?test=${Date.now()}`);

    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateJwk = privateKey.export({ format: "jwk" });
    const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "ES256", use: "sig", key_ops: ["verify"] };
    const signingKey = await webcrypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const now = Math.floor(Date.now() / 1000);
    const url = "https://app.example/api/usage-guide";
    const bodySha256 = Buffer.from(await webcrypto.subtle.digest("SHA-256", new Uint8Array())).toString("base64url");
    const claims = Buffer.from(JSON.stringify({
      aud: "intellite-app-proxy",
      appId: "example-workflow",
      routeId: "usage-guide-read",
      method: "GET",
      path: "/api/usage-guide",
      query: "",
      jti: "abcdefghijklmnop",
      iat: now,
      exp: now + 300,
      userId: "user-1",
      userEmail: "user@example.com",
      orgId: "org-1",
      capabilities: ["example-workflow.read"]
    })).toString("base64url");
    const payload = [String(now), "GET", "/api/usage-guide", "", bodySha256, claims].join("\n");
    const signature = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, new TextEncoder().encode(payload))).toString("base64url");
    const headers = {
      "X-Intellite-Proxy-Algorithm": "ES256",
      "X-Intellite-Proxy-Key-Id": "test-key",
      "X-Intellite-Proxy-Timestamp": String(now),
      "X-Intellite-Proxy-Body-Sha256": bodySha256,
      "X-Intellite-Proxy-Claims": claims,
      "X-Intellite-Proxy-Signature": signature
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const actor = await verifier.verifyIntelliteProxyRequest(new Request(url, { headers }), {
        appId: "example-workflow",
        jwksUrl: "https://intellite.example/.well-known/intellite-app-proxy-jwks.json",
        requiredCapability: "example-workflow.read"
      });
      assert.equal(actor.userId, "user-1");
      assert.equal(actor.orgId, "org-1");

      const authorized = await verifier.authorizeIntelliteProxyRequest(new Request(url, { headers }), {
        appId: "example-workflow",
        jwksUrl: "https://intellite.example/.well-known/intellite-app-proxy-jwks.json",
        requiredCapability: "example-workflow.read",
        connectionStore: {
          async findOrganizationLink({ intelliteOrgId }) {
            assert.equal(intelliteOrgId, "org-1");
            return { status: "active", localTenantId: "tenant-1" };
          },
          async findUserLink({ intelliteUserId, localTenantId }) {
            assert.equal(intelliteUserId, "user-1");
            assert.equal(localTenantId, "tenant-1");
            return { status: "active", localTenantId, localUserId: "local-user-1" };
          }
        },
        authorizeLocalAccess: async ({ localTenantId, localUserId, requiredCapability }) =>
          localTenantId === "tenant-1" && localUserId === "local-user-1" && requiredCapability === "example-workflow.read"
      });
      assert.equal(authorized.localTenantId, "tenant-1");
      assert.equal(authorized.localUserId, "local-user-1");

      await assert.rejects(
        verifier.authorizeIntelliteProxyRequest(new Request(url, { headers }), {
          appId: "example-workflow",
          jwksUrl: "https://intellite.example/.well-known/intellite-app-proxy-jwks.json",
          requiredCapability: "example-workflow.read",
          connectionStore: {
            async findOrganizationLink() { return { status: "active", localTenantId: "tenant-1" }; },
            async findUserLink() { return { status: "active", localTenantId: "tenant-1", localUserId: "local-user-1" }; }
          },
          authorizeLocalAccess: async () => false
        }),
        /existing-app role or ACL denied/
      );

      await assert.rejects(
        verifier.verifyIntelliteProxyRequest(new Request(url, {
          headers: { ...headers, "X-Intellite-Proxy-Signature": `A${signature.slice(1)}` }
        }), {
          appId: "example-workflow",
          jwksUrl: "https://intellite.example/.well-known/intellite-app-proxy-jwks.json",
          requiredCapability: "example-workflow.read"
        }),
        /invalid Intellite proxy signature/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("generated OAuth adapter uses server-side state, PKCE, narrow scope, revalidation, and one-time consumption", async () => {
  await withTempHome(async (home) => {
    const manifestPath = path.join(home, "intellite.app.json");
    const init = await runCli(["app", "init", "--output", manifestPath], { home });
    assert.equal(init.code, 0);
    const adapter = await import(`${pathToFileURL(path.join(home, "intellite", "intellite-oauth.mjs")).href}?test=${Date.now()}`);
    let transaction;
    let consumed = false;
    const transactionStore = {
      async create(value) { transaction = value; return true; },
      async consume({ stateHash }) {
        if (consumed || stateHash !== transaction?.stateHash) return null;
        consumed = true;
        return transaction;
      }
    };
    const calls = [];
    let userinfoIntent = "link";
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(JSON.stringify({
          issuer: "https://intellite.example",
          authorization_endpoint: "https://intellite.example/oauth/authorize",
          token_endpoint: "https://intellite.example/oauth/token",
          userinfo_endpoint: "https://intellite.example/oauth/userinfo",
          revocation_endpoint: "https://intellite.example/oauth/revoke"
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (String(url).endsWith("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "token-value", token_type: "Bearer", expires_in: 600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (String(url).endsWith("/oauth/userinfo")) {
        return new Response(JSON.stringify({
          sub: "intellite-user-1",
          name: "User",
          email: "user@example.com",
          client_id: "example-workflow",
          capabilities: ["example-workflow.read"],
          intellite_intent: userinfoIntent,
          org: { id: "org-1", name: "Org", role: "partner" },
          membership: { role: "member" }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 200 });
    };

    await assert.rejects(
      adapter.createIntelliteConnectionRequest({
        issuer: "https://intellite.example",
        redirectUri: "https://app.example/api/auth/intellite/callback",
        intent: "link",
        capabilities: ["example-workflow.read"],
        localUserId: "local-user-1",
        localTenantId: "tenant-1",
        returnTo: "https://attacker.example",
        transactionStore,
        fetchImpl
      }),
      /returnTo must be an app-relative path/
    );
    await assert.rejects(
      adapter.createIntelliteConnectionRequest({
        issuer: "https://user:secret@intellite.example",
        redirectUri: "https://app.example/api/auth/intellite/callback",
        intent: "link",
        capabilities: ["example-workflow.read"],
        localUserId: "local-user-1",
        localTenantId: "tenant-1",
        transactionStore,
        fetchImpl
      }),
      /unsafe Intellite issuer URL/
    );

    const started = await adapter.createIntelliteConnectionRequest({
      issuer: "https://intellite.example",
      redirectUri: "https://app.example/api/auth/intellite/callback",
      intent: "link",
      capabilities: ["example-workflow.read"],
      localUserId: "local-user-1",
      localTenantId: "tenant-1",
      transactionStore,
      fetchImpl
    });
    const authorizationUrl = new URL(started.authorizationUrl);
    assert.equal(authorizationUrl.searchParams.get("intellite_intent"), "link");
    assert.equal(authorizationUrl.searchParams.get("scope"), "example-workflow.read");
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(transaction.localUserId, "local-user-1");
    assert.equal(authorizationUrl.searchParams.has("localUserId"), false);
    assert.equal(authorizationUrl.searchParams.has("code_verifier"), false);

    const state = authorizationUrl.searchParams.get("state");
    await assert.rejects(
      adapter.completeIntelliteConnectionCallback({
        callbackUrl: `https://app.example/api/auth/intellite/callback?code=code-value&state=tampered-${state}`,
        transactionStore,
        authorizeLocalActor: async () => true,
        fetchImpl
      }),
      /invalid or replayed Intellite OAuth state/
    );
    const completed = await adapter.completeIntelliteConnectionCallback({
      callbackUrl: `https://app.example/api/auth/intellite/callback?code=code-value&state=${state}`,
      transactionStore,
      authorizeLocalActor: async (stored) => stored.localUserId === "local-user-1" && stored.localTenantId === "tenant-1",
      fetchImpl
    });
    assert.equal(completed.identity.intelliteUserId, "intellite-user-1");
    assert.equal(completed.identity.intelliteOrgId, "org-1");
    assert.deepEqual(completed.identity.capabilities, ["example-workflow.read"]);
    assert.match(String(calls.find((call) => call.url.endsWith("/oauth/token"))?.options.body), /code_verifier=/);
    await assert.rejects(
      adapter.completeIntelliteConnectionCallback({
        callbackUrl: `https://app.example/api/auth/intellite/callback?code=code-value&state=${state}`,
        transactionStore,
        authorizeLocalActor: async () => true,
        fetchImpl
      }),
      /invalid or replayed Intellite OAuth state/
    );

    consumed = false;
    userinfoIntent = "login";
    const loginStarted = await adapter.createIntelliteConnectionRequest({
      issuer: "https://intellite.example",
      redirectUri: "https://app.example/api/auth/intellite/callback",
      intent: "login",
      capabilities: ["example-workflow.read"],
      returnTo: "/dashboard",
      transactionStore,
      fetchImpl
    });
    const loginState = new URL(loginStarted.authorizationUrl).searchParams.get("state");
    await assert.rejects(
      adapter.completeIntelliteConnectionCallback({
        callbackUrl: `https://app.example/api/auth/intellite/callback?code=login-code&state=${loginState}`,
        transactionStore,
        fetchImpl
      }),
      /existing login mapping resolver is required/
    );

    consumed = false;
    const secondLogin = await adapter.createIntelliteConnectionRequest({
      issuer: "https://intellite.example",
      redirectUri: "https://app.example/api/auth/intellite/callback",
      intent: "login",
      capabilities: ["example-workflow.read"],
      returnTo: "/dashboard",
      transactionStore,
      fetchImpl
    });
    const secondLoginState = new URL(secondLogin.authorizationUrl).searchParams.get("state");
    const loginCompleted = await adapter.completeIntelliteConnectionCallback({
      callbackUrl: `https://app.example/api/auth/intellite/callback?code=login-code&state=${secondLoginState}`,
      transactionStore,
      resolveExistingLoginMapping: async (identity) => ({
        status: identity.intelliteUserId === "intellite-user-1" ? "active" : "missing",
        localUserId: "local-user-1",
        localTenantId: "tenant-1"
      }),
      fetchImpl
    });
    assert.equal(loginCompleted.transaction.localUserId, "local-user-1");
    assert.equal(loginCompleted.transaction.localTenantId, "tenant-1");
    assert.equal(loginCompleted.transaction.returnTo, "/dashboard");
  });
});

test("app refresh does not overwrite user-edited guidance files", async () => {
  await withTempHome(async (home) => {
    const manifestPath = path.join(home, "intellite.app.json");
    const init = await runCli(["app", "init", "--output", manifestPath], { home });
    assert.equal(init.code, 0);

    const guidancePath = path.join(home, ".intellite", "agent-guidance.md");
    const oauthPath = path.join(home, "intellite", "intellite-oauth.mjs");
    await fs.appendFile(guidancePath, "\nCustom project note.\n", "utf8");
    await fs.appendFile(oauthPath, "\n// Custom OAuth integration note.\n", "utf8");
    await fs.rm(path.join(home, ".intellite", "guidance-lock.json"), { force: true });

    const refresh = await runCli(["app", "refresh", manifestPath], { home });
    assert.equal(refresh.code, 0);
    const body = JSON.parse(refresh.stdout);
    const guidanceResult = body.guidance.files.find((file) => file.path === ".intellite/agent-guidance.md");
    assert.equal(guidanceResult.status, "conflict");
    assert.match(await fs.readFile(guidancePath, "utf8"), /Custom project note/);
    assert.match(await fs.readFile(path.join(home, guidanceResult.newPath), "utf8"), /Intellite App Agent Guidance/);
    const oauthResult = body.guidance.files.find((file) => file.path === "intellite/intellite-oauth.mjs");
    assert.equal(oauthResult.status, "conflict");
    assert.match(await fs.readFile(oauthPath, "utf8"), /Custom OAuth integration note/);
    assert.match(await fs.readFile(path.join(home, oauthResult.newPath), "utf8"), /createIntelliteConnectionRequest/);

    const secondRefresh = await runCli(["app", "refresh", manifestPath], { home });
    assert.equal(secondRefresh.code, 0);
    const secondBody = JSON.parse(secondRefresh.stdout);
    assert.equal(secondBody.guidance.files.find((file) => file.path === ".intellite/agent-guidance.md").status, "conflict");
    assert.match(await fs.readFile(guidancePath, "utf8"), /Custom project note/);

    const doctor = await runCli(["app", "doctor", manifestPath], { home });
    assert.equal(doctor.code, 1);
    const doctorBody = JSON.parse(doctor.stdout);
    assert.equal(doctorBody.ok, false);
    assert.match(JSON.stringify(doctorBody.checks), /modified/);
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

test("app validate rejects platform-managed environment fields", async () => {
  await withTempHome(async (home) => {
    const manifestPath = path.join(home, "managed-fields.app.json");
    const init = await runCli(["app", "init", "--output", manifestPath], { home });
    assert.equal(init.code, 0);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.environments.staging.serviceBinding = "RPA_BOX_API";
    manifest.environments.staging.proxySecretName = "INTELLITE_APP_PROXY_SECRET_RPA_BOX";
    manifest.environments.staging.identityForwarding = "signed_pages_email";
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const validate = await runCli(["app", "validate", manifestPath], { home });
    assert.equal(validate.code, 1);
    const body = JSON.parse(validate.stdout);
    assert.match(JSON.stringify(body.errors), /serviceBinding is platform-managed/);
    assert.match(JSON.stringify(body.errors), /proxySecretName is platform-managed/);
    assert.match(JSON.stringify(body.errors), /identityForwarding is platform-managed/);
  });
});

test("app validate rejects proxy route patterns that the server rejects for regex safety", async () => {
  await withTempHome(async (home) => {
    const manifestPath = path.join(home, "unsafe-regex.app.json");
    const init = await runCli(["app", "init", "--output", manifestPath], { home });
    assert.equal(init.code, 0);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.proxyRoutes[0].publicPathPattern = "^/(a+)+$";
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const validate = await runCli(["app", "validate", manifestPath], { home });
    assert.equal(validate.code, 1);
    const body = JSON.parse(validate.stdout);
    assert.equal(body.ok, false);
    assert.match(JSON.stringify(body.errors), /repetition quantifier/);
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
  assert.match(cli, /\/api\/organization\/developer\/apps\/probe/);
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
