#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CONFIG_DIR = path.join(os.homedir(), ".intellite");
const ENVIRONMENTS = {
  production: {
    name: "production",
    baseUrl: "https://intellite.app",
    configFileName: "config.json",
    skillsDirName: "skills",
    dpapiTokenFileName: "token.dpapi",
    tokenEnv: "INTELLITE_TOKEN",
    skillsDirEnv: "INTELLITE_SKILLS_DIR",
    tokenService: "intellite-cli",
    tokenAccount: "default",
    tokenLabel: "Intellite CLI token"
  },
  staging: {
    name: "staging",
    baseUrl: "https://intellite-staging.intellite.workers.dev",
    configFileName: "config.staging.json",
    skillsDirName: "skills-staging",
    dpapiTokenFileName: "token.staging.dpapi",
    tokenEnv: "INTELLITE_STAGING_TOKEN",
    skillsDirEnv: "INTELLITE_STAGING_SKILLS_DIR",
    tokenService: "intellite-cli-staging",
    tokenAccount: "staging",
    tokenLabel: "Intellite CLI staging token"
  }
};
let activeEnvironment = ENVIRONMENTS.production;
let DEFAULT_BASE_URL = activeEnvironment.baseUrl;
let CONFIG_FILE = path.join(CONFIG_DIR, activeEnvironment.configFileName);
let SKILLS_DIR = process.env[activeEnvironment.skillsDirEnv] || path.join(CONFIG_DIR, activeEnvironment.skillsDirName);
const MANAGED_SKILL_FILE = ".intellite-managed.json";
const AGENT_SKILL_DIRS_ENV = "INTELLITE_AGENT_SKILLS_DIRS";
const CODEX_SKILLS_DIR_ENV = "INTELLITE_CODEX_SKILLS_DIR";
const CODEX_SYNC_ENV = "INTELLITE_SYNC_CODEX_SKILLS";
let TOKEN_SERVICE = activeEnvironment.tokenService;
let TOKEN_ACCOUNT = activeEnvironment.tokenAccount;
let TOKEN_LABEL = activeEnvironment.tokenLabel;
let DPAPI_TOKEN_FILE = path.join(CONFIG_DIR, activeEnvironment.dpapiTokenFileName);
const CLI_VERSION = "0.3.13";
const DEFAULT_PERMISSIONS = [];
const MAX_JSON_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_SKILLS = 20;
const MAX_SKILL_FILES = 20;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const APP_GUIDANCE_VERSION = "2026-07-09.3";
const APP_GUIDANCE_DIR = ".intellite";
const APP_GUIDANCE_LOCK_FILE = "guidance-lock.json";
const APP_API_PREFIX = "/api/intellite/apps/";
const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,159}$/;
const ROLE_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const INTEGRATION_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,159}$/;
const APP_ENVIRONMENTS = ["local", "staging", "production"];
const APP_ROUTE_METHODS = new Set(["*", "READ", "WRITE", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const ACTION_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ACTION_RISKS = new Set(["read", "write", "workflow_run", "external_artifact", "external_send", "destructive"]);
const ACTION_APPROVALS = new Set(["auto", "confirm", "admin"]);
const WRITE_ROUTE_METHODS = new Set(["*", "WRITE", "POST", "PUT", "PATCH", "DELETE"]);

function usage() {
  console.log(`intellite

Commands:
  login [--name NAME] [--permission APP_ID:CAPABILITY] [--force]
  agent setup
  agent status
  agent skills
  agent context
  agent api METHOD PATH [--query KEY=VALUE] [--json JSON] [--body FILE]
  agent download PATH [--output FILE]
  status
  setup
  skills
  api METHOD PATH [--query KEY=VALUE] [--json JSON] [--body FILE]
  download PATH [--output FILE]
  app init [--output intellite.app.json]
  app validate [FILE]
  app conformance [FILE]
  app refresh [FILE]
  app doctor [FILE]
  app list
  app publish [FILE] --app-env staging
  app request-production-review [FILE]
  logout

Options:
  --env production|staging  Target official Intellite environment

Environment:
  INTELLITE_TOKEN               Production token override for ephemeral automation
  INTELLITE_SKILLS_DIR          Production skill sync directory
  INTELLITE_STAGING_TOKEN       Staging token override for ephemeral automation
  INTELLITE_STAGING_SKILLS_DIR  Staging skill sync directory
  INTELLITE_AGENT_SKILLS_DIRS   Extra skill directories to sync, separated by ${path.delimiter}
  INTELLITE_SYNC_CODEX_SKILLS   Set to 0 to skip ~/.codex/skills sync
  INTELLITE_TOKEN_STORE         auto, secure, or file
`);
}

function configureEnvironment(name) {
  const normalized = String(name || "production").trim().toLowerCase();
  const environment = normalized === "prod" ? ENVIRONMENTS.production : ENVIRONMENTS[normalized];
  if (!environment) throw new Error(`Unknown environment: ${name}`);
  activeEnvironment = environment;
  DEFAULT_BASE_URL = environment.baseUrl;
  CONFIG_FILE = path.join(CONFIG_DIR, environment.configFileName);
  SKILLS_DIR = process.env[environment.skillsDirEnv] || path.join(CONFIG_DIR, environment.skillsDirName);
  TOKEN_SERVICE = environment.tokenService;
  TOKEN_ACCOUNT = environment.tokenAccount;
  TOKEN_LABEL = environment.tokenLabel;
  DPAPI_TOKEN_FILE = path.join(CONFIG_DIR, environment.dpapiTokenFileName);
}

function extractGlobalOptions(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--env") {
      if (index + 1 >= args.length) throw new Error("--env requires production or staging.");
      configureEnvironment(args[index + 1]);
      index += 1;
      continue;
    }
    if (value.startsWith("--env=")) {
      configureEnvironment(value.slice("--env=".length));
      continue;
    }
    result.push(value);
  }
  return result;
}

function loginCommandHint() {
  return activeEnvironment.name === "production" ? "intellite login" : `intellite --env ${activeEnvironment.name} login`;
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

function appApiPath(pathname) {
  return String(pathname || "").startsWith(APP_API_PREFIX);
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

function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function arrayText(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => textValue(item)).filter(Boolean)));
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
    return url.protocol === "https:" || (url.protocol === "http:" && local);
  } catch {
    return false;
  }
}

function urlIsLocalhost(value) {
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function stagingUrlLooksProduction(url) {
  const value = String(url || "").toLowerCase();
  return !value.includes("staging") && !value.includes("localhost") && /(intellite\.app|rpa-box\.com|pages\.dev)/.test(value);
}

function productionUrlLooksStaging(url) {
  const value = String(url || "").toLowerCase();
  return value.includes("staging") || value.includes("workers.dev");
}

function routeMatchesRootCatchAll(pattern) {
  try {
    const regex = new RegExp(pattern);
    return regex.test("/") && regex.test("/__intellite_probe__/nested");
  } catch {
    return false;
  }
}

function routeLooksBroadWrite(pattern, method) {
  return WRITE_ROUTE_METHODS.has(method) && /(?:\.\*|\.\+|\[\^\/\]\*(?:\)|$)|\(\?:\/\.\*\)\?)/.test(pattern);
}

function unsafeProxyPathPatternReason(pattern) {
  if (pattern.length > 256) return "pattern is longer than 256 characters";
  if (!pattern.startsWith("^")) return "pattern must be anchored with ^";
  if (/\\[1-9]/.test(pattern)) return "backreferences are not allowed";
  if (/\(\?<[=!]/.test(pattern)) return "lookbehind groups are not allowed";
  const groupStack = [];
  let inClass = false;
  let closedGroup = null;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
      closedGroup = null;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      closedGroup = null;
      continue;
    }
    if (char === "(") {
      groupStack.push({ hasQuantifier: false, hasAlternation: false });
      closedGroup = null;
      continue;
    }
    if (char === ")") {
      closedGroup = groupStack.pop() ?? null;
      continue;
    }
    if (char === "|") {
      for (const frame of groupStack) frame.hasAlternation = true;
      closedGroup = null;
      continue;
    }
    if (char === "*" || char === "+" || char === "{") {
      if (closedGroup && (closedGroup.hasQuantifier || closedGroup.hasAlternation)) {
        return "a repetition quantifier is applied to a group that contains a quantifier or alternation";
      }
      for (const frame of groupStack) frame.hasQuantifier = true;
    }
    closedGroup = null;
  }
  return "";
}

function manifestIssue(pathname, message) {
  return { path: pathname, message };
}

function normalizeManifest(value) {
  const root = recordValue(value);
  if (!root) return null;
  return {
    schemaVersion: root.schemaVersion,
    appId: textValue(root.appId),
    code: textValue(root.code),
    name: textValue(root.name),
    description: textValue(root.description),
    version: textValue(root.version),
    visibility: ["private", "organization", "public"].includes(root.visibility) ? root.visibility : "private",
    capabilities: Array.isArray(root.capabilities) ? root.capabilities.map((item) => typeof item === "string" ? { id: item } : recordValue(item)).filter(Boolean) : [],
    roles: Array.isArray(root.roles) ? root.roles.map(recordValue).filter(Boolean) : [],
    environments: recordValue(root.environments) || {},
    proxyRoutes: Array.isArray(root.proxyRoutes) ? root.proxyRoutes.map(recordValue).filter(Boolean) : [],
    skills: Array.isArray(root.skills) ? root.skills.map(recordValue).filter(Boolean) : [],
    resources: Array.isArray(root.resources) ? root.resources.map(recordValue).filter(Boolean) : [],
    actions: Array.isArray(root.actions) ? root.actions.map(recordValue).filter(Boolean) : [],
    events: Array.isArray(root.events) ? root.events.map(recordValue).filter(Boolean) : [],
    usageGuide: recordValue(root.usageGuide) || {},
    lifecycle: recordValue(root.lifecycle) || {}
  };
}

function validateAppManifestObject(value) {
  const manifest = normalizeManifest(value);
  const errors = [];
  const warnings = [];
  if (!manifest) return { ok: false, errors: [manifestIssue("$", "Manifest must be a JSON object.")], warnings: [] };
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) errors.push(manifestIssue("$.schemaVersion", "schemaVersion must be 1 or 2."));
  if (!APP_ID_PATTERN.test(manifest.appId)) errors.push(manifestIssue("$.appId", "appId is invalid."));
  if (!manifest.name) errors.push(manifestIssue("$.name", "name is required."));
  if (!manifest.version) errors.push(manifestIssue("$.version", "version is required."));

  const declaredCapabilities = new Set();
  manifest.capabilities.forEach((capability, index) => {
    const id = textValue(capability?.id);
    if (!CAPABILITY_PATTERN.test(id)) errors.push(manifestIssue(`$.capabilities[${index}].id`, "Capability id is invalid."));
    else declaredCapabilities.add(id);
  });
  if (declaredCapabilities.size === 0) errors.push(manifestIssue("$.capabilities", "At least one capability is required."));

  const defaultRoles = [];
  manifest.roles.forEach((role, index) => {
    const id = textValue(role.id);
    const capabilities = arrayText(role.capabilities);
    if (!ROLE_PATTERN.test(id)) errors.push(manifestIssue(`$.roles[${index}].id`, "Role id is invalid."));
    if (role.default === true) defaultRoles.push(id);
    if (capabilities.length === 0) errors.push(manifestIssue(`$.roles[${index}].capabilities`, "Role must declare capabilities."));
    for (const capability of capabilities) {
      if (!declaredCapabilities.has(capability)) errors.push(manifestIssue(`$.roles[${index}].capabilities`, `Undeclared capability: ${capability}`));
    }
  });
  if (manifest.roles.length === 0) errors.push(manifestIssue("$.roles", "At least one role is required."));
  if (defaultRoles.length !== 1) errors.push(manifestIssue("$.roles", "Exactly one role must set default: true."));

  for (const environment of APP_ENVIRONMENTS) {
    const config = recordValue(manifest.environments[environment]);
    if (!config) {
      errors.push(manifestIssue(`$.environments.${environment}`, `${environment} environment is required.`));
      continue;
    }
    const appBaseUrl = textValue(config.appBaseUrl);
    const proxyBaseUrl = textValue(config.proxyBaseUrl);
    if (!appBaseUrl && !proxyBaseUrl) errors.push(manifestIssue(`$.environments.${environment}`, "appBaseUrl or proxyBaseUrl is required."));
    for (const [key, url] of Object.entries({ appBaseUrl, proxyBaseUrl })) {
      if (url && !isHttpUrl(url)) errors.push(manifestIssue(`$.environments.${environment}.${key}`, `${key} must be https or localhost.`));
    }
    for (const [key, values] of Object.entries({ oauthRedirectUris: arrayText(config.oauthRedirectUris), orgSelectRedirectUris: arrayText(config.orgSelectRedirectUris) })) {
      values.forEach((redirectUri, index) => {
        if (!isHttpUrl(redirectUri)) errors.push(manifestIssue(`$.environments.${environment}.${key}[${index}]`, "Redirect URI must be https or localhost."));
        if (redirectUri.includes("*")) errors.push(manifestIssue(`$.environments.${environment}.${key}[${index}]`, "Redirect URI must not contain wildcards."));
      });
    }
    const urls = [appBaseUrl, proxyBaseUrl, ...arrayText(config.oauthRedirectUris), ...arrayText(config.orgSelectRedirectUris)].filter(Boolean);
    if (environment !== "local" && urls.some(urlIsLocalhost)) errors.push(manifestIssue(`$.environments.${environment}`, "Only local environment may use localhost URLs."));
    if (environment === "staging" && urls.some(stagingUrlLooksProduction)) errors.push(manifestIssue("$.environments.staging", "Staging URLs appear to reference production domains."));
    if (environment === "production" && urls.some(productionUrlLooksStaging)) errors.push(manifestIssue("$.environments.production", "Production URLs appear to reference staging domains."));
  }

  manifest.proxyRoutes.forEach((route, index) => {
    const method = textValue(route.method || "*").toUpperCase();
    const pattern = textValue(route.publicPathPattern);
    const replacement = textValue(route.upstreamPathReplacement);
    const capabilities = arrayText(route.capabilities);
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(textValue(route.routeId))) errors.push(manifestIssue(`$.proxyRoutes[${index}].routeId`, "routeId is invalid."));
    if (!APP_ROUTE_METHODS.has(method)) errors.push(manifestIssue(`$.proxyRoutes[${index}].method`, "method is invalid."));
    if (!pattern.startsWith("^/")) errors.push(manifestIssue(`$.proxyRoutes[${index}].publicPathPattern`, "publicPathPattern must be anchored under /."));
    try {
      new RegExp(pattern);
    } catch {
      errors.push(manifestIssue(`$.proxyRoutes[${index}].publicPathPattern`, "publicPathPattern is not valid regex."));
    }
    const unsafePatternReason = unsafeProxyPathPatternReason(pattern);
    if (unsafePatternReason) {
      errors.push(manifestIssue(`$.proxyRoutes[${index}].publicPathPattern`, `publicPathPattern is rejected for safety: ${unsafePatternReason}.`));
    }
    if (routeMatchesRootCatchAll(pattern)) errors.push(manifestIssue(`$.proxyRoutes[${index}].publicPathPattern`, "Developer app proxy routes must not be root catch-all patterns."));
    if (routeLooksBroadWrite(pattern, method)) errors.push(manifestIssue(`$.proxyRoutes[${index}].publicPathPattern`, "Broad write proxy routes require platform-owned first-party routing."));
    if (!replacement.startsWith("/") && replacement !== "$&") errors.push(manifestIssue(`$.proxyRoutes[${index}].upstreamPathReplacement`, "upstreamPathReplacement must be a path replacement."));
    if (/^https?:\/\//i.test(replacement)) errors.push(manifestIssue(`$.proxyRoutes[${index}].upstreamPathReplacement`, "upstreamPathReplacement must not include an origin."));
    if (capabilities.length === 0) errors.push(manifestIssue(`$.proxyRoutes[${index}].capabilities`, "Route must require capabilities."));
    for (const capability of capabilities) {
      if (!declaredCapabilities.has(capability)) errors.push(manifestIssue(`$.proxyRoutes[${index}].capabilities`, `Undeclared capability: ${capability}`));
    }
  });

  manifest.skills.forEach((skill, index) => {
    if (!SKILL_NAME_PATTERN.test(textValue(skill.name))) errors.push(manifestIssue(`$.skills[${index}].name`, "Skill name is invalid."));
    for (const capability of arrayText(skill.requiredCapabilities)) {
      if (!declaredCapabilities.has(capability)) errors.push(manifestIssue(`$.skills[${index}].requiredCapabilities`, `Undeclared capability: ${capability}`));
    }
    if (!textValue(skill.signature)) {
      warnings.push(manifestIssue(`$.skills[${index}].signature`, "Skill package has no signature. Intellite signs unsigned skills during publish and production review."));
    }
    for (const file of Array.isArray(skill.files) ? skill.files : []) {
      const filePath = textValue(recordValue(file)?.path);
      if (!filePath || path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes("..")) {
        errors.push(manifestIssue(`$.skills[${index}].files`, "Skill file paths must be relative and must not contain .. segments."));
      }
    }
  });

  const declaredResources = new Set();
  manifest.resources.forEach((resource, index) => {
    const type = textValue(resource.type);
    if (!INTEGRATION_ID_PATTERN.test(type)) errors.push(manifestIssue(`$.resources[${index}].type`, "Resource type is invalid."));
    else declaredResources.add(type);
    for (const capability of arrayText(resource.capabilities)) {
      if (!declaredCapabilities.has(capability)) errors.push(manifestIssue(`$.resources[${index}].capabilities`, `Undeclared capability: ${capability}`));
    }
    const referencePattern = textValue(resource.referencePattern);
    if (referencePattern && !referencePattern.startsWith("intellite://apps/")) errors.push(manifestIssue(`$.resources[${index}].referencePattern`, "referencePattern must use intellite://apps/."));
  });

  manifest.actions.forEach((action, index) => {
    const id = textValue(action.id);
    const method = textValue(action.method).toUpperCase();
    const pathTemplate = textValue(action.pathTemplate);
    const capability = textValue(action.capability);
    const resourceType = textValue(action.resourceType);
    const risk = textValue(action.risk);
    const approval = textValue(action.approval);
    if (!INTEGRATION_ID_PATTERN.test(id)) errors.push(manifestIssue(`$.actions[${index}].id`, "Action id is invalid."));
    if (!ACTION_METHODS.has(method)) errors.push(manifestIssue(`$.actions[${index}].method`, "Action method is invalid."));
    if (!pathTemplate.startsWith("/")) errors.push(manifestIssue(`$.actions[${index}].pathTemplate`, "Action pathTemplate must start with /."));
    if (/^https?:\/\//i.test(pathTemplate)) errors.push(manifestIssue(`$.actions[${index}].pathTemplate`, "Action pathTemplate must not include an origin."));
    if (!declaredCapabilities.has(capability)) errors.push(manifestIssue(`$.actions[${index}].capability`, `Undeclared capability: ${capability}`));
    if (resourceType && !declaredResources.has(resourceType)) errors.push(manifestIssue(`$.actions[${index}].resourceType`, `Undeclared resource type: ${resourceType}`));
    if (!ACTION_RISKS.has(risk)) errors.push(manifestIssue(`$.actions[${index}].risk`, "Action risk is invalid."));
    if (!ACTION_APPROVALS.has(approval)) errors.push(manifestIssue(`$.actions[${index}].approval`, "Action approval is invalid."));
    if ((risk === "external_send" || risk === "destructive") && approval === "auto") {
      errors.push(manifestIssue(`$.actions[${index}].approval`, "High-risk actions must require confirm or admin approval."));
    }
  });

  manifest.events.forEach((event, index) => {
    const id = textValue(event.id);
    const resourceType = textValue(event.resourceType);
    const schemaVersion = Number(event.schemaVersion);
    if (!INTEGRATION_ID_PATTERN.test(id)) errors.push(manifestIssue(`$.events[${index}].id`, "Event id is invalid."));
    if (!Number.isInteger(schemaVersion) || schemaVersion <= 0) errors.push(manifestIssue(`$.events[${index}].schemaVersion`, "Event schemaVersion must be a positive integer."));
    if (resourceType && !declaredResources.has(resourceType)) errors.push(manifestIssue(`$.events[${index}].resourceType`, `Undeclared resource type: ${resourceType}`));
    for (const capability of arrayText(event.capabilities)) {
      if (!declaredCapabilities.has(capability)) errors.push(manifestIssue(`$.events[${index}].capabilities`, `Undeclared capability: ${capability}`));
    }
  });
  if (!manifest.proxyRoutes.some((route) => /usage-guide/.test(textValue(route.publicPathPattern)))) warnings.push(manifestIssue("$.proxyRoutes", "No usage-guide proxy route is declared."));
  if (manifest.skills.length === 0) warnings.push(manifestIssue("$.skills", "No skill package is declared."));
  if (manifest.visibility === "public" && manifest.lifecycle.productionReviewRequired === false) errors.push(manifestIssue("$.lifecycle.productionReviewRequired", "Public production apps must require Intellite review."));
  return { ok: errors.length === 0, errors, warnings, manifest };
}

function sampleAppManifest() {
  return {
    schemaVersion: 2,
    appId: "example-workflow",
    name: "Example Workflow",
    description: "Example Intellite-connected business app.",
    version: "0.1.0",
    visibility: "private",
    capabilities: [
      { id: "example-workflow.read", label: "Read" },
      { id: "example-workflow.write", label: "Write" },
      { id: "example-workflow.admin", label: "Admin" }
    ],
    roles: [
      { id: "viewer", label: "Viewer", capabilities: ["example-workflow.read"], default: true },
      { id: "member", label: "Member", capabilities: ["example-workflow.read", "example-workflow.write"] },
      { id: "admin", label: "Admin", capabilities: ["example-workflow.read", "example-workflow.write", "example-workflow.admin"] }
    ],
    environments: {
      local: {
        appBaseUrl: "http://localhost:5173",
        proxyBaseUrl: "http://localhost:8788",
        oauthRedirectUris: ["http://localhost:5173/api/auth/intellite/callback"]
      },
      staging: {
        appBaseUrl: "https://staging.example-app.example.com",
        proxyBaseUrl: "https://staging.example-app.example.com",
        oauthRedirectUris: ["https://staging.example-app.example.com/api/auth/intellite/callback"]
      },
      production: {
        appBaseUrl: "https://example-app.example.com",
        proxyBaseUrl: "https://example-app.example.com",
        oauthRedirectUris: ["https://example-app.example.com/api/auth/intellite/callback"]
      }
    },
    proxyRoutes: [
      {
        routeId: "usage-guide-read",
        method: "READ",
        publicPathPattern: "^/usage-guide$",
        upstreamPathReplacement: "/api/usage-guide",
        capabilities: ["example-workflow.read"],
        sort: 10
      },
      {
        routeId: "standard-api-read",
        method: "READ",
        publicPathPattern: "^/v1/.*",
        upstreamPathReplacement: "/api$&",
        capabilities: ["example-workflow.read"],
        sort: 100
      }
    ],
    skills: [
      {
        name: "example-workflow",
        displayName: "Example Workflow App",
        description: "Operate Example Workflow through the Intellite local agent path.",
        version: "0.1.0",
        requiredCapabilities: ["example-workflow.read"],
        signature: "replace-with-intellite-platform-signature",
        files: [{ path: "SKILL.md", content: "# Example Workflow App\n\nUse `intellite agent api` with `/api/intellite/apps/example-workflow/...` paths only.\n" }]
      }
    ],
    resources: [
      {
        type: "workflow",
        capabilities: ["example-workflow.read"],
        referencePattern: "intellite://apps/example-workflow/workflows/{resourceId}"
      }
    ],
    actions: [
      {
        id: "workflow.run",
        method: "POST",
        pathTemplate: "/v1/workflows/{resourceId}/runs",
        capability: "example-workflow.write",
        resourceType: "workflow",
        risk: "workflow_run",
        approval: "confirm",
        idempotent: true
      }
    ],
    events: [
      {
        id: "workflow.completed",
        resourceType: "workflow",
        schemaVersion: 1,
        capabilities: ["example-workflow.read"]
      }
    ],
    usageGuide: { path: "/api/usage-guide", format: "markdown" },
    lifecycle: { productionReviewRequired: true }
  };
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function guidanceAppId(manifest) {
  const appId = textValue(recordValue(manifest)?.appId);
  return APP_ID_PATTERN.test(appId) ? appId : "your-app-id";
}

function guidanceTemplates(manifest) {
  const appId = guidanceAppId(manifest);
  return [
    {
      path: `${APP_GUIDANCE_DIR}/agent-guidance.md`,
      content: `<!-- intellite-app-guidance-version: ${APP_GUIDANCE_VERSION} -->
# Intellite App Agent Guidance

This project-local file teaches AI coding agents how to work on this repository as an Intellite app. Keep it in the repo. Do not install it into global skill directories.

## Boundary

- Intellite is the control plane: authentication, organization selection, app entitlement, capability grants, audit, manifest registry, and signed app-call tickets.
- This app owns the business data plane: app routes, database, documents, business rules, and user-facing workflows.
- Agents and users should call this app through Intellite paths such as \`/api/intellite/apps/${appId}/...\`, not by calling the app origin directly.
- Do not add global Codex skills for this app unless the user explicitly asks. Project-local guidance is the source of truth for development.

## Local Development Flow

1. Edit \`intellite.app.json\`.
2. Run \`npx intellite app validate intellite.app.json\`.
3. Run \`npx intellite app doctor intellite.app.json\`.
4. Run \`npx intellite --env staging app publish intellite.app.json --app-env staging\` only after local checks pass.
5. Request production with \`npx intellite --env staging app request-production-review intellite.app.json\`. Production activation is review-gated.

## Manifest Rules

- Use \`schemaVersion: 2\` for resources, actions, and events.
- Keep capabilities narrow. A role should contain only the capabilities it needs.
- Do not declare root catch-all proxy routes.
- Do not declare broad write proxy routes for external apps.
- Actions with \`risk: "external_send"\` or \`risk: "destructive"\` must use \`approval: "confirm"\` or \`approval: "admin"\`.
- Missing skill signatures are acceptable locally. Intellite signs unsigned skill packages during publish and production review when platform signing is configured.

## App Implementation Requirements

- Implement a usage-guide endpoint and declare it in \`proxyRoutes\`.
- Verify Intellite proxy signatures on requests that arrive with \`X-Intellite-Proxy-*\` headers.
- Enforce the signed capabilities supplied by Intellite on each request.
- Reject stale timestamps, expired claims, body hash mismatches, and replayed request IDs.
- Never use sample identities, unsigned \`X-Intellite-*\` headers, test organization IDs, or display names as production authority.

See \`.intellite/examples/usage-guide.md\` and \`.intellite/examples/proxy-signature-verification.md\`.
`
    },
    {
      path: `${APP_GUIDANCE_DIR}/examples/usage-guide.md`,
      content: `<!-- intellite-app-guidance-version: ${APP_GUIDANCE_VERSION} -->
# Usage Guide Endpoint Example

Expose a read-only endpoint that returns concise instructions for agents operating this app through Intellite.

Recommended route:

\`\`\`text
GET /api/usage-guide
\`\`\`

Recommended manifest route:

\`\`\`json
{
  "routeId": "usage-guide-read",
  "method": "READ",
  "publicPathPattern": "^/usage-guide$",
  "upstreamPathReplacement": "/api/usage-guide",
  "capabilities": ["${appId}.read"]
}
\`\`\`

The response should explain only supported app operations. It should not include secrets, app-origin credentials, customer-specific examples, or unsupported endpoints.
`
    },
    {
      path: `${APP_GUIDANCE_DIR}/examples/proxy-signature-verification.md`,
      content: `<!-- intellite-app-guidance-version: ${APP_GUIDANCE_VERSION} -->
# Intellite Proxy Signature Verification Example

Every state-changing or data-bearing app route reached through Intellite must verify the signed proxy request before trusting the user, organization, or capabilities in the headers.

Minimum checks:

- Verify \`X-Intellite-Proxy-Signature\` with HMAC-SHA256 using the proxy secret configured for this app.
- Build the signature payload as \`timestamp + "\\n" + method + "\\n" + pathname + "\\n" + search + "\\n" + bodySha256 + "\\n" + claims\`.
- Verify \`X-Intellite-Proxy-Body-Sha256\` against the raw request body bytes.
- Decode \`X-Intellite-Proxy-Claims\` as base64url JSON and check \`aud\`, \`appId\`, \`method\`, \`path\`, \`query\`, \`exp\`, \`jti\`, and \`capabilities\`.
- Reject stale timestamps.
- Reject replayed \`jti\` values with durable storage until at least the claim expiry.
- Check the declared capability before reading or writing app data.
- Fail closed on missing headers, missing secret, signature mismatch, stale timestamp, replay, or insufficient capability.

Node/Fetch-style verification skeleton:

\`\`\`js
import crypto from "node:crypto";

const AUDIENCE = "intellite-app-proxy";
const MAX_CLOCK_SKEW_SECONDS = 300;

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function fail(message, status = 401) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

export async function verifyIntelliteProxyRequest(request, { appId, proxySecret, requiredCapability, replayStore }) {
  if (!proxySecret) fail("missing Intellite proxy secret", 503);
  const url = new URL(request.url);
  const timestamp = request.headers.get("x-intellite-proxy-timestamp") || "";
  const signature = request.headers.get("x-intellite-proxy-signature") || "";
  const bodySha256 = request.headers.get("x-intellite-proxy-body-sha256") || "";
  const encodedClaims = request.headers.get("x-intellite-proxy-claims") || "";
  if (!timestamp || !signature || !bodySha256 || !encodedClaims) fail("missing Intellite proxy signature headers");

  const now = Math.floor(Date.now() / 1000);
  if (!/^\\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) fail("stale Intellite proxy timestamp");

  const rawBody = Buffer.from(await request.clone().arrayBuffer());
  const actualBodySha256 = base64url(crypto.createHash("sha256").update(rawBody).digest());
  if (!timingSafeEqualText(actualBodySha256, bodySha256)) fail("invalid Intellite proxy body hash");

  const payload = [timestamp, request.method.toUpperCase(), url.pathname, url.search, bodySha256, encodedClaims].join("\\n");
  const expectedSignature = base64url(crypto.createHmac("sha256", proxySecret).update(payload).digest());
  if (!timingSafeEqualText(expectedSignature, signature)) fail("invalid Intellite proxy signature");

  const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8"));
  if (claims.aud !== AUDIENCE || claims.appId !== appId) fail("invalid Intellite proxy audience");
  if (claims.method !== request.method.toUpperCase() || claims.path !== url.pathname || claims.query !== url.search) fail("invalid Intellite proxy target");
  if (!Number.isFinite(claims.exp) || claims.exp < now) fail("expired Intellite proxy claims");
  if (!claims.jti || await replayStore.has(claims.jti)) fail("replayed Intellite proxy request");
  await replayStore.put(claims.jti, claims.exp);
  if (!Array.isArray(claims.capabilities) || !claims.capabilities.includes(requiredCapability)) fail("missing Intellite capability", 403);

  return {
    userId: claims.userId,
    userEmail: claims.userEmail,
    orgId: claims.orgId,
    capabilities: claims.capabilities
  };
}
\`\`\`

Do not bypass this by trusting app-origin sessions, display names, email text, or unsigned local development headers.
`
    }
  ];
}

function guidanceLockPath(projectRoot) {
  return path.join(projectRoot, APP_GUIDANCE_DIR, APP_GUIDANCE_LOCK_FILE);
}

function projectRelativePath(projectRoot, filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, "/");
}

function assertProjectLocalPath(projectRoot, relativePath) {
  const target = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside the Intellite app project: ${relativePath}`);
  }
  return target;
}

async function readTextFileNoSymlink(filePath) {
  await assertNotSymlink(filePath);
  return fs.readFile(filePath, "utf8");
}

async function readGuidanceLock(projectRoot) {
  try {
    const lock = JSON.parse(await readTextFileNoSymlink(guidanceLockPath(projectRoot)));
    return recordValue(lock) || {};
  } catch {
    return {};
  }
}

function guidanceFileMap(lock) {
  const files = recordValue(lock?.files) || {};
  return Object.fromEntries(Object.entries(files).map(([key, value]) => [key, recordValue(value) || {}]));
}

async function writeGuidanceLock(projectRoot, lockFiles) {
  const lock = {
    managedBy: "intellite",
    kind: "app-guidance",
    version: APP_GUIDANCE_VERSION,
    updatedAt: new Date().toISOString(),
    files: lockFiles
  };
  const lockPath = guidanceLockPath(projectRoot);
  await ensureDirectoryNoSymlink(path.dirname(lockPath), projectRoot);
  await writeTextFileNoSymlink(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

async function nextNewFilePath(filePath, content) {
  for (let index = 0; index < 100; index += 1) {
    const candidate = `${filePath}.new${index === 0 ? "" : `.${index}`}`;
    try {
      const existing = await readTextFileNoSymlink(candidate);
      if (existing === content) return candidate;
    } catch (error) {
      if (error?.code === "ENOENT") return candidate;
      throw error;
    }
  }
  throw new Error(`Too many pending .new files for ${filePath}`);
}

async function writeAppGuidance(projectRoot, manifest, { refresh = false } = {}) {
  const templates = guidanceTemplates(manifest);
  const previousLock = await readGuidanceLock(projectRoot);
  const previousFiles = guidanceFileMap(previousLock);
  const nextLockFiles = {};
  const results = [];

  for (const template of templates) {
    const filePath = assertProjectLocalPath(projectRoot, template.path);
    const relativePath = projectRelativePath(projectRoot, filePath);
    const desiredHash = sha256Hex(template.content);
    const previousHash = textValue(previousFiles[relativePath]?.sha256);
    await ensureDirectoryNoSymlink(path.dirname(filePath), projectRoot);

    let existing = "";
    let exists = false;
    try {
      existing = await readTextFileNoSymlink(filePath);
      exists = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    if (!exists) {
      await writeTextFileNoSymlink(filePath, template.content);
      results.push({ path: relativePath, status: "created" });
      nextLockFiles[relativePath] = { sha256: desiredHash };
      continue;
    }

    const existingHash = sha256Hex(existing);
    if (existingHash === desiredHash) {
      results.push({ path: relativePath, status: "unchanged" });
      nextLockFiles[relativePath] = { sha256: desiredHash };
      continue;
    }

    if (refresh && previousHash && existingHash === previousHash) {
      await writeTextFileNoSymlink(filePath, template.content);
      results.push({ path: relativePath, status: "updated" });
      nextLockFiles[relativePath] = { sha256: desiredHash };
      continue;
    }

    const newPath = await nextNewFilePath(filePath, template.content);
    await writeTextFileNoSymlink(newPath, template.content);
    results.push({ path: relativePath, status: "conflict", newPath: projectRelativePath(projectRoot, newPath) });
    nextLockFiles[relativePath] = previousHash ? { sha256: previousHash } : {};
  }

  await writeGuidanceLock(projectRoot, nextLockFiles);
  return {
    version: APP_GUIDANCE_VERSION,
    dir: path.join(projectRoot, APP_GUIDANCE_DIR),
    files: results
  };
}

async function appGuidanceStatus(projectRoot, manifest) {
  const templates = guidanceTemplates(manifest);
  const lock = await readGuidanceLock(projectRoot);
  const files = guidanceFileMap(lock);
  const checks = [];
  for (const template of templates) {
    const filePath = assertProjectLocalPath(projectRoot, template.path);
    const relativePath = projectRelativePath(projectRoot, filePath);
    const desiredHash = sha256Hex(template.content);
    let status = "missing";
    let ok = false;
    try {
      const existing = await readTextFileNoSymlink(filePath);
      const existingHash = sha256Hex(existing);
      if (existingHash === desiredHash) {
        status = "current";
        ok = true;
      } else if (textValue(files[relativePath]?.sha256) === existingHash) {
        status = "outdated";
      } else {
        status = "modified";
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    checks.push({ name: `guidance:${relativePath}`, ok, status });
  }
  checks.push({ name: "guidance:lock-current", ok: textValue(lock.version) === APP_GUIDANCE_VERSION, status: textValue(lock.version) || "missing" });
  return checks;
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
  const token = process.env[activeEnvironment.tokenEnv];
  if (token) {
    return {
      token
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

function codexSkillsDir() {
  const explicit = process.env[CODEX_SKILLS_DIR_ENV];
  if (explicit) return path.resolve(explicit);
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.resolve(codexHome, "skills");
}

function extraAgentSkillDirs() {
  const value = process.env[AGENT_SKILL_DIRS_ENV] || "";
  return value
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function skillSyncTargets() {
  const targets = [
    { label: "intellite", dir: localSkillsDir(), codex: false }
  ];
  if (process.env[CODEX_SYNC_ENV] !== "0") {
    targets.push({ label: "codex", dir: codexSkillsDir(), codex: true });
  }
  for (const dir of extraAgentSkillDirs()) {
    targets.push({ label: "extra", dir, codex: true });
  }
  const seen = new Set();
  return targets.filter((target) => {
    const key = path.resolve(target.dir).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function yamlQuoted(value) {
  return JSON.stringify(String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
}

function hasYamlFrontmatter(content) {
  return String(content || "").trimStart().startsWith("---\n") || String(content || "").trimStart().startsWith("---\r\n");
}

function codexSkillFileContent(skill, file) {
  const content = String(file.content || "");
  if (file.path !== "SKILL.md" || hasYamlFrontmatter(content)) return content;
  const description = skill.description || skill.displayName || skill.name;
  return [
    "---",
    `name: ${yamlQuoted(skill.name)}`,
    `description: ${yamlQuoted(description)}`,
    "metadata:",
    `  version: ${yamlQuoted(skill.version || "")}`,
    '  source: "intellite"',
    "---",
    "",
    content
  ].join("\n");
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
    throw new Error("Custom API endpoints are not supported. Use --env production or --env staging.");
  }
  const force = args.includes("--force");
  const tokenFromEnv = Boolean(process.env[activeEnvironment.tokenEnv]);
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
        throw new Error(`${activeEnvironment.tokenEnv} is set but could not be verified: ${error instanceof Error ? error.message : String(error)}`);
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
  if (!config?.token) throw new Error(`Not logged in. Run \`${loginCommandHint()}\`.`);
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
  if (!config?.token) throw new Error(`Not logged in. Run \`${loginCommandHint()}\`.`);
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

function assertAppTicketUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("Intellite returned an invalid app URL.");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Intellite returned an unsafe app URL.");
  }
  return url.toString();
}

const APP_TICKET_HEADER_ALLOWLIST = new Set([
  "x-pages-user-email",
  "x-pages-identity-timestamp",
  "x-pages-identity-signature",
  "x-user-email",
  "x-organization-id"
]);

function isAllowedAppTicketHeader(key) {
  const normalized = String(key || "").trim().toLowerCase();
  return /^x-intellite-[a-z0-9-]+$/.test(normalized) || APP_TICKET_HEADER_ALLOWLIST.has(normalized);
}

function appTicketHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Intellite returned invalid app call headers.");
  }
  const headers = new Headers();
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") continue;
    if (!isAllowedAppTicketHeader(key)) continue;
    if ([...item].some((char) => char.charCodeAt(0) > 255)) continue;
    headers.set(key, item);
  }
  if (!headers.get("X-Intellite-Proxy-Signature") || !headers.get("X-Intellite-Proxy-Timestamp")) {
    throw new Error("Intellite did not return signed app call headers.");
  }
  return headers;
}

async function appDirectFetch(pathname, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const rawBody = options.body === undefined || options.body === null ? "" : options.body;
  const bodySha256 = sha256Base64url(rawBody);
  const { body: ticket } = await authenticatedRequest("/api/intellite/app-call-ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, path: pathname, bodySha256 })
  });
  if (!ticket || typeof ticket !== "object") throw new Error("Intellite did not return an app call ticket.");
  const url = assertAppTicketUrl(ticket.url);
  const headers = appTicketHeaders(ticket.headers);
  const sourceHeaders = new Headers(options.headers || {});
  const contentType = sourceHeaders.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  const accept = sourceHeaders.get("Accept");
  if (accept) headers.set("Accept", accept);
  const idempotencyKey = sourceHeaders.get("Idempotency-Key");
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return fetch(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : rawBody,
    redirect: "manual"
  });
}

async function appDirectRequest(pathname, options = {}) {
  const response = await appDirectFetch(pathname, options);
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

async function status() {
  const { body } = await authenticatedRequest("/api/intellite/status");
  console.log(JSON.stringify(body, null, 2));
}

function agentHelp() {
  console.log(`intellite agent

Local AI agent commands:
  agent setup
  agent status
  agent skills
  agent context
  agent api METHOD PATH [--query KEY=VALUE] [--json JSON] [--body FILE]
  agent download PATH [--output FILE]

Use these commands from a local AI assistant or automation. Keep using
/api/intellite/apps/<app-id>/... paths; the CLI exchanges them for signed direct
app calls and writes files locally with agent download. The local agent path is
the supported end-user integration surface.
`);
}

async function agentStatus() {
  const { body } = await authenticatedRequest("/api/intellite/status");
  console.log(JSON.stringify({
    mode: "local-agent",
    environment: activeEnvironment.name,
    baseUrl: DEFAULT_BASE_URL,
    skillsDir: localSkillsDir(),
    syncedSkillDirs: skillSyncTargets().map((target) => ({ label: target.label, dir: target.dir, codex: target.codex })),
    status: body
  }, null, 2));
}

async function agentContext() {
  const [{ body }, skills] = await Promise.all([
    authenticatedRequest("/api/intellite/status"),
    fetchSkills()
  ]);
  console.log(JSON.stringify({
    mode: "local-agent",
    environment: activeEnvironment.name,
    baseUrl: DEFAULT_BASE_URL,
    skillsDir: localSkillsDir(),
    syncedSkillDirs: skillSyncTargets().map((target) => ({ label: target.label, dir: target.dir, codex: target.codex })),
    commands: {
      setup: "intellite agent setup",
      status: "intellite agent status",
      skills: "intellite agent skills",
      api: "intellite agent api METHOD /api/intellite/apps/<app-id>/...",
      download: "intellite agent download /api/intellite/apps/<app-id>/path/to/file --output file.ext"
    },
    rules: [
      "Use synced local skills first for app-specific behavior.",
      "If an app call fails unexpectedly, run agent setup or agent skills, read the app usage guide, and retry once.",
      "Call app APIs only through /api/intellite/apps/<app-id>/...",
      "Use agent download for files that must appear on this machine.",
      "Do not call app origins directly or ask the user for passwords, tokens, Basic Auth values, invite URLs, or reset URLs."
    ],
    status: body,
    skills: skills.map((skill) => ({
      name: skill.name,
      displayName: skill.displayName,
      description: skill.description,
      version: skill.version,
      appId: skill.appId,
      capabilities: skill.capabilities,
      requiredPermissions: skill.requiredPermissions,
      grantedPermissions: skill.grantedPermissions
    }))
  }, null, 2));
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

async function managedSkillDirectories(root) {
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
      const marker = await readManagedSkillMarker(dir);
      if (marker?.managedBy === "intellite" && marker?.name === entry.name) managed.push({ name: entry.name, dir });
    } catch {
      // Unmanaged skill directories are left untouched.
    }
  }
  return managed;
}

async function readManagedSkillMarker(skillDir) {
  const markerPath = path.join(skillDir, MANAGED_SKILL_FILE);
  await assertNotSymlink(markerPath);
  return JSON.parse(await fs.readFile(markerPath, "utf8"));
}

async function assertCanOverwriteSkillDirectory(skillDir, skillName) {
  let stats;
  try {
    stats = await fs.lstat(skillDir);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${skillDir}`);
  if (!stats.isDirectory()) throw new Error(`Refusing to overwrite non-directory skill path: ${skillDir}`);
  let marker;
  try {
    marker = await readManagedSkillMarker(skillDir);
  } catch {
    marker = null;
  }
  if (marker?.managedBy !== "intellite" || marker?.name !== skillName) {
    throw new Error(`Refusing to overwrite unmanaged skill directory: ${skillDir}. Remove or rename it, or add a valid ${MANAGED_SKILL_FILE} marker.`);
  }
}

async function syncSkillsToRoot(skills, root, options = {}) {
  await fs.mkdir(root, { recursive: true });
  const current = new Set(skills.map((skill) => skill.name));

  for (const skill of skills) {
    const skillDir = path.join(root, skill.name);
    const resolvedSkillDir = path.resolve(skillDir);
    await assertCanOverwriteSkillDirectory(skillDir, skill.name);
    await fs.mkdir(skillDir, { recursive: true });
    for (const file of skill.files) {
      const target = path.resolve(skillDir, file.path);
      if (target !== resolvedSkillDir && !target.startsWith(`${resolvedSkillDir}${path.sep}`)) {
        throw new Error(`Invalid resolved skill file path from Intellite: ${file.path}`);
      }
      await ensureDirectoryNoSymlink(path.dirname(target), resolvedSkillDir);
      await writeTextFileNoSymlink(target, options.codex ? codexSkillFileContent(skill, file) : file.content);
    }
    await writeTextFileNoSymlink(
      path.join(skillDir, MANAGED_SKILL_FILE),
      JSON.stringify({ managedBy: "intellite", name: skill.name, version: skill.version, installedAt: new Date().toISOString() }, null, 2),
    );
  }

  for (const previous of await managedSkillDirectories(root)) {
    if (!current.has(previous.name)) await fs.rm(previous.dir, { recursive: true, force: true });
  }
}

async function setupSkills({ quiet = false } = {}) {
  const skills = await fetchSkills();
  const targets = skillSyncTargets();

  for (const target of targets) {
    await syncSkillsToRoot(skills, target.dir, { codex: target.codex });
  }

  if (!quiet) {
    console.log(JSON.stringify({
      skillsDir: localSkillsDir(),
      syncedSkillDirs: targets.map((target) => ({ label: target.label, dir: target.dir, codex: target.codex })),
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

async function appInit(args) {
  const output = argValue(args, "--output", "intellite.app.json");
  const filePath = path.resolve(output);
  const projectRoot = path.dirname(filePath);
  try {
    await fs.stat(filePath);
    throw new Error(`Refusing to overwrite existing file: ${filePath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await assertNotSymlink(filePath);
  const manifest = sampleAppManifest();
  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), { mode: 0o644 });
  const guidance = await writeAppGuidance(projectRoot, manifest, { refresh: false });
  console.log(JSON.stringify({ ok: true, filePath, guidance }, null, 2));
}

async function readAppManifestFile(args) {
  const filePath = path.resolve(args[0] || "intellite.app.json");
  return { filePath, manifest: await readJsonFile(filePath) };
}

function printManifestValidation(result, filePath) {
  console.log(JSON.stringify({
    ok: result.ok,
    filePath,
    appId: result.manifest?.appId || "",
    version: result.manifest?.version || "",
    errors: result.errors,
    warnings: result.warnings
  }, null, 2));
}

async function appValidate(args) {
  const { filePath, manifest } = await readAppManifestFile(args);
  const result = validateAppManifestObject(manifest);
  printManifestValidation(result, filePath);
  if (!result.ok) process.exitCode = 1;
}

function appConformanceChecks(normalized) {
  const checks = [];
  if (!normalized) return checks;
  const routeIds = new Set();
  for (const route of normalized.proxyRoutes) {
    const routeId = textValue(route.routeId);
    checks.push({ name: `proxy-route:${routeId}`, ok: Boolean(routeId) && !routeIds.has(routeId) });
    routeIds.add(routeId);
  }
  for (const environment of APP_ENVIRONMENTS) {
    const config = recordValue(normalized.environments[environment]);
    const urls = config ? [textValue(config.appBaseUrl), textValue(config.proxyBaseUrl), ...arrayText(config.oauthRedirectUris), ...arrayText(config.orgSelectRedirectUris)].filter(Boolean) : [];
    checks.push({ name: `environment:${environment}`, ok: Boolean(config) && urls.length > 0 });
    if (environment === "staging") checks.push({ name: "environment:staging-not-production", ok: !urls.some((url) => !url.includes("staging") && /intellite\.app|rpa-box\.com|pages\.dev/.test(url) && !url.includes("localhost")) });
    if (environment === "production") checks.push({ name: "environment:production-not-staging", ok: !urls.some((url) => url.includes("staging") || url.includes("workers.dev")) });
  }
  checks.push({ name: "usage-guide-route", ok: normalized.proxyRoutes.some((route) => /usage-guide/.test(textValue(route.publicPathPattern))) });
  checks.push({ name: "skill-package", ok: normalized.skills.length > 0 });
  checks.push({ name: "production-review-required", ok: normalized.visibility !== "public" || normalized.lifecycle.productionReviewRequired !== false });
  return checks;
}

function readinessChecks(normalized) {
  const checks = [];
  if (!normalized) return checks;
  const sampleAppId = normalized.appId === "example-workflow";
  const sampleName = normalized.name === "Example Workflow";
  const environmentUrls = APP_ENVIRONMENTS.flatMap((environment) => {
    const config = recordValue(normalized.environments[environment]);
    return config ? [textValue(config.appBaseUrl), textValue(config.proxyBaseUrl), ...arrayText(config.oauthRedirectUris), ...arrayText(config.orgSelectRedirectUris)].filter(Boolean) : [];
  });
  const sampleUrls = environmentUrls.filter((url) => {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return hostname === "example-app.example.com" || hostname === "staging.example-app.example.com";
    } catch {
      return false;
    }
  });
  checks.push({
    name: "project-values:replace-sample-app-id",
    ok: !sampleAppId,
    status: sampleAppId ? "sample" : "custom"
  });
  checks.push({
    name: "project-values:replace-sample-name",
    ok: !sampleName,
    status: sampleName ? "sample" : "custom"
  });
  checks.push({
    name: "project-values:replace-sample-urls",
    ok: sampleUrls.length === 0,
    status: sampleUrls.length === 0 ? "custom" : "sample",
    urls: sampleUrls
  });
  return checks;
}

async function appConformance(args) {
  const { filePath, manifest } = await readAppManifestFile(args);
  const result = validateAppManifestObject(manifest);
  const checks = appConformanceChecks(result.manifest);
  const ok = result.ok && checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    filePath,
    validation: { errors: result.errors, warnings: result.warnings },
    checks
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

async function appRefresh(args) {
  const { filePath, manifest } = await readAppManifestFile(args);
  const result = validateAppManifestObject(manifest);
  const guidance = await writeAppGuidance(path.dirname(filePath), result.manifest || manifest, { refresh: true });
  console.log(JSON.stringify({
    ok: true,
    filePath,
    validationOk: result.ok,
    guidance,
    validation: { errors: result.errors, warnings: result.warnings }
  }, null, 2));
}

async function appDoctor(args) {
  const { filePath, manifest } = await readAppManifestFile(args);
  const result = validateAppManifestObject(manifest);
  const conformanceChecks = appConformanceChecks(result.manifest);
  const readyChecks = readinessChecks(result.manifest);
  const guidanceChecks = await appGuidanceStatus(path.dirname(filePath), result.manifest || manifest);
  const manualChecks = [
    {
      name: "intellite-proxy-signature-verification",
      status: "manual",
      message: "Verify the app implementation checks X-Intellite-Proxy-* HMAC signatures, claims expiry, replay IDs, body hashes, and capabilities."
    }
  ];
  const checks = [
    { name: "manifest-valid", ok: result.ok },
    ...conformanceChecks,
    ...readyChecks,
    ...guidanceChecks
  ];
  const ok = result.ok && checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    filePath,
    appId: result.manifest?.appId || "",
    version: result.manifest?.version || "",
    validation: { errors: result.errors, warnings: result.warnings },
    checks,
    manualChecks
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

async function appPublish(args) {
  const clean = withoutOptions(args, ["--app-env"]);
  const targetEnvironment = argValue(args, "--app-env", "staging").trim().toLowerCase();
  if (!APP_ENVIRONMENTS.includes(targetEnvironment)) throw new Error("--app-env must be local, staging, or production.");
  const { filePath, manifest } = await readAppManifestFile(clean);
  const result = validateAppManifestObject(manifest);
  if (!result.ok) {
    printManifestValidation(result, filePath);
    process.exitCode = 1;
    return;
  }
  const readyChecks = readinessChecks(result.manifest);
  if (!readyChecks.every((check) => check.ok)) {
    console.log(JSON.stringify({
      ok: false,
      filePath,
      appId: result.manifest?.appId || "",
      version: result.manifest?.version || "",
      errors: readyChecks.filter((check) => !check.ok).map((check) => manifestIssue(`$ readiness:${check.name}`, "Replace sample app init values before publishing.")),
      checks: readyChecks
    }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (targetEnvironment === "production") {
    throw new Error("Production app publication requires Intellite review and is not published by this CLI command yet.");
  }
  const { body } = await authenticatedRequest(`/api/organization/developer/apps/manifest/publish?env=${encodeURIComponent(targetEnvironment)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ environment: targetEnvironment, manifest })
  });
  console.log(JSON.stringify({ filePath, ...body }, null, 2));
}

async function appRequestProductionReview(args) {
  const { filePath, manifest } = await readAppManifestFile(args);
  const result = validateAppManifestObject(manifest);
  if (!result.ok) {
    printManifestValidation(result, filePath);
    process.exitCode = 1;
    return;
  }
  const readyChecks = readinessChecks(result.manifest);
  if (!readyChecks.every((check) => check.ok)) {
    console.log(JSON.stringify({
      ok: false,
      filePath,
      appId: result.manifest?.appId || "",
      version: result.manifest?.version || "",
      errors: readyChecks.filter((check) => !check.ok).map((check) => manifestIssue(`$ readiness:${check.name}`, "Replace sample app init values before requesting production review.")),
      checks: readyChecks
    }, null, 2));
    process.exitCode = 1;
    return;
  }
  const { body } = await authenticatedRequest("/api/organization/developer/apps/manifest/request-production-review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifest })
  });
  console.log(JSON.stringify({ filePath, ...body }, null, 2));
}

async function appList() {
  const { body } = await authenticatedRequest("/api/organization/developer/apps");
  console.log(JSON.stringify(body, null, 2));
}

async function appCommand(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    console.log(`intellite app

Commands:
  app init [--output intellite.app.json]
  app validate [FILE]
  app conformance [FILE]
  app refresh [FILE]
  app doctor [FILE]
  app list
  app publish [FILE] --app-env staging
  app request-production-review [FILE]
`);
    return;
  }
  if (subcommand === "init") return appInit(rest);
  if (subcommand === "validate") return appValidate(rest);
  if (subcommand === "conformance") return appConformance(rest);
  if (subcommand === "refresh") return appRefresh(rest);
  if (subcommand === "doctor") return appDoctor(rest);
  if (subcommand === "list") return appList();
  if (subcommand === "publish") return appPublish(rest);
  if (subcommand === "request-production-review") return appRequestProductionReview(rest);
  throw new Error(`Unknown app command: ${subcommand}`);
}

async function agentCommand(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    agentHelp();
    return;
  }
  if (subcommand === "setup" || subcommand === "sync") return setupSkills();
  if (subcommand === "status") return agentStatus();
  if (subcommand === "skills") return listSkills();
  if (subcommand === "context") return agentContext();
  if (subcommand === "api") return api(rest);
  if (subcommand === "download") return download(rest);
  throw new Error(`Unknown agent command: ${subcommand}`);
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
  const transport = appApiPath(pathname) ? appDirectRequest : authenticatedRequest;
  const { body } = await transport(pathname, {
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
  const response = appApiPath(pathname) ? await appDirectFetch(pathname) : await authenticatedFetch(pathname);
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
  const [command, ...args] = extractGlobalOptions(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(CLI_VERSION);
    return;
  }
  if (command === "login") return login(args);
  if (command === "status") return status();
  if (command === "setup") return setupSkills();
  if (command === "skills") return listSkills();
  if (command === "agent") return agentCommand(args);
  if (command === "app") return appCommand(args);
  if (command === "logout") return logout();
  if (command === "api") return api(args);
  if (command === "download") return download(args);
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
