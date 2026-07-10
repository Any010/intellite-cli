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
const CLI_VERSION = "0.4.1";
const DEFAULT_PERMISSIONS = [];
const MAX_JSON_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_SKILLS = 20;
const MAX_SKILL_FILES = 20;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const APP_GUIDANCE_VERSION = "2026-07-10.3";
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
  app adopt [--output intellite.app.json] [--app-id APP_ID] [--name NAME]
  app validate [FILE]
  app conformance [FILE]
  app refresh [FILE]
  app doctor [FILE]
  app probe [FILE] [--path /usage-guide]
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
    if (config.serviceBinding) errors.push(manifestIssue(`$.environments.${environment}.serviceBinding`, "serviceBinding is platform-managed and cannot be declared by an external app."));
    if (config.proxySecretName) errors.push(manifestIssue(`$.environments.${environment}.proxySecretName`, "proxySecretName is platform-managed and cannot be declared by an external app."));
    if (config.identityForwarding) errors.push(manifestIssue(`$.environments.${environment}.identityForwarding`, "identityForwarding is platform-managed and cannot be declared by an external app."));
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

function proxyVerifierModuleTemplate(appId) {
  return `// Generated by Intellite. Refresh with: npx intellite app refresh intellite.app.json
const INTELLITE_APP_ID = ${JSON.stringify(appId)};
const INTELLITE_PROXY_AUDIENCE = "intellite-app-proxy";
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const jwksCache = new Map();

export class IntelliteProxyVerificationError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "IntelliteProxyVerificationError";
    this.status = status;
  }
}
` + proxyVerifierModuleTemplateTail();
}

function oauthConnectionModuleTemplate(appId) {
  return `// Generated by Intellite. Refresh with: npx intellite app refresh intellite.app.json
const INTELLITE_APP_ID = ${JSON.stringify(appId)};
const TRANSACTION_TTL_MS = 5 * 60 * 1000;
const metadataCache = new Map();

export class IntelliteConnectionError extends Error {
  constructor(message, status = 400, code = "intellite_connection_error") {
    super(message);
    this.name = "IntelliteConnectionError";
    this.status = status;
    this.code = code;
  }
}

function fail(message, status, code) {
  throw new IntelliteConnectionError(message, status, code);
}

function base64url(bytes) {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let offset = 0; offset < view.length; offset += 0x8000) binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
}

function randomValue(bytes) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64url(value);
}

async function sha256(value) {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))));
}

function trustedUrl(value, label) {
  let url;
  try { url = new URL(String(value || "")); } catch { fail("invalid " + label, 503, "unsafe_configuration"); }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) fail("unsafe " + label, 503, "unsafe_configuration");
  if (url.username || url.password || url.hash) fail("unsafe " + label, 503, "unsafe_configuration");
  return url;
}

function normalizedIssuer(value) {
  const url = trustedUrl(value, "Intellite issuer URL");
  url.pathname = url.pathname.replace(/\\/+$/, "");
  url.search = "";
  return url.toString().replace(/\\/$/, "");
}

function normalizedCapabilities(value) {
  const capabilities = Array.from(new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean))).sort();
  if (capabilities.length === 0 || capabilities.length > 50 || capabilities.some((item) => !/^[a-z0-9][a-z0-9._:-]{0,159}$/.test(item))) {
    fail("invalid Intellite capability scope", 500, "invalid_scope_configuration");
  }
  return capabilities;
}

function normalizedIntent(value) {
  const intent = String(value || "link");
  if (!["login", "link", "install"].includes(intent)) fail("invalid Intellite connection intent", 500, "invalid_intent_configuration");
  return intent;
}

function normalizedLocalId(value, label) {
  const id = String(value || "").trim();
  if (id && (id.length > 200 || /[\\u0000-\\u001f\\u007f]/.test(id))) fail("invalid " + label, 500, "invalid_local_mapping");
  return id;
}

function normalizedReturnTo(value) {
  const returnTo = String(value || "/");
  if (!returnTo.startsWith("/") || returnTo.startsWith("//") || /[\\r\\n\\u0000]/.test(returnTo)) {
    fail("returnTo must be an app-relative path", 500, "invalid_return_to");
  }
  return returnTo;
}

function requiredTransactionStore(store) {
  if (!store || typeof store.create !== "function" || typeof store.consume !== "function") {
    fail("a durable Intellite transactionStore is required", 503, "transaction_store_required");
  }
  return store;
}

async function oauthMetadata(issuer, fetchImpl = fetch) {
  const normalized = normalizedIssuer(issuer);
  const cached = metadataCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await fetchImpl(normalized + "/.well-known/oauth-authorization-server", {
    headers: { Accept: "application/json" },
    redirect: "error"
  });
  if (!response.ok) fail("Intellite OAuth metadata is unavailable", 503, "metadata_unavailable");
  const body = await response.json();
  if (body?.issuer !== normalized) fail("Intellite OAuth issuer mismatch", 503, "issuer_mismatch");
  const metadata = {
    issuer: normalized,
    authorizationEndpoint: trustedUrl(body.authorization_endpoint, "authorization endpoint").toString(),
    tokenEndpoint: trustedUrl(body.token_endpoint, "token endpoint").toString(),
    userinfoEndpoint: trustedUrl(body.userinfo_endpoint || normalized + "/oauth/userinfo", "userinfo endpoint").toString(),
    revocationEndpoint: trustedUrl(body.revocation_endpoint || normalized + "/oauth/revoke", "revocation endpoint").toString()
  };
  for (const endpoint of [metadata.authorizationEndpoint, metadata.tokenEndpoint, metadata.userinfoEndpoint, metadata.revocationEndpoint]) {
    if (new URL(endpoint).origin !== new URL(normalized).origin) fail("cross-origin Intellite OAuth metadata is not allowed", 503, "metadata_origin_mismatch");
  }
  metadataCache.set(normalized, { value: metadata, expiresAt: Date.now() + 5 * 60 * 1000 });
  return metadata;
}

export async function createIntelliteConnectionRequest(options = {}) {
  const appId = String(options.appId || INTELLITE_APP_ID);
  const redirectUri = trustedUrl(options.redirectUri, "redirect URI").toString();
  const intent = normalizedIntent(options.intent);
  const capabilities = normalizedCapabilities(options.capabilities);
  const transactionStore = requiredTransactionStore(options.transactionStore);
  const metadata = await oauthMetadata(options.issuer, options.fetchImpl);
  const state = randomValue(32);
  const codeVerifier = randomValue(48);
  const codeChallenge = await sha256(codeVerifier);
  const expiresAt = new Date(Date.now() + TRANSACTION_TTL_MS).toISOString();
  const transaction = Object.freeze({
    stateHash: await sha256(state),
    codeVerifier,
    appId,
    issuer: metadata.issuer,
    redirectUri,
    intent,
    capabilities,
    localUserId: normalizedLocalId(options.localUserId, "local user ID"),
    localTenantId: normalizedLocalId(options.localTenantId, "local tenant ID"),
    returnTo: normalizedReturnTo(options.returnTo),
    expiresAt
  });
  if (intent !== "login" && (!transaction.localUserId || !transaction.localTenantId)) {
    fail("link and install require an authenticated local actor and tenant", 403, "local_actor_required");
  }
  const created = await transactionStore.create(transaction);
  if (created === false) fail("could not create Intellite connection transaction", 503, "transaction_store_failed");

  const authorizationUrl = new URL(metadata.authorizationEndpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", appId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("scope", capabilities.join(" "));
  authorizationUrl.searchParams.set("intellite_intent", intent);
  authorizationUrl.searchParams.set("prompt", "consent");
  if (options.intelliteOrgId) authorizationUrl.searchParams.set("org", String(options.intelliteOrgId));
  return Object.freeze({ authorizationUrl: authorizationUrl.toString(), expiresAt });
}

function callbackMatchesRedirect(callbackUrl, redirectUri) {
  const callback = trustedUrl(callbackUrl, "callback URL");
  const expected = trustedUrl(redirectUri, "stored redirect URI");
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) return false;
  for (const [key, value] of expected.searchParams) if (callback.searchParams.get(key) !== value) return false;
  return true;
}

async function fetchUserInfo(metadata, accessToken, fetchImpl) {
  const response = await fetchImpl(metadata.userinfoEndpoint, {
    headers: { Accept: "application/json", Authorization: "Bearer " + accessToken },
    redirect: "error"
  });
  if (!response.ok) fail("Intellite identity is no longer active", response.status === 403 ? 403 : 401, "identity_inactive");
  return response.json();
}

function verifiedIdentity(body, transaction) {
  const capabilities = Array.isArray(body?.capabilities) ? body.capabilities.map(String) : [];
  const responseIntent = String(body?.intellite_intent || "");
  if (body?.client_id !== transaction.appId) fail("Intellite OAuth client mismatch", 401, "client_mismatch");
  if (!body?.sub || !body?.org?.id) fail("Intellite identity response is incomplete", 401, "identity_incomplete");
  if (responseIntent !== transaction.intent) fail("Intellite connection intent mismatch", 401, "intent_mismatch");
  if (transaction.capabilities.some((capability) => !capabilities.includes(capability))) fail("Intellite capability scope was reduced", 403, "insufficient_scope");
  return Object.freeze({
    intelliteUserId: String(body.sub),
    intelliteOrgId: String(body.org.id),
    userName: String(body.name || body.account?.name || ""),
    userEmail: String(body.email || ""),
    organizationName: String(body.org.name || ""),
    organizationRole: String(body.org.role || body.membership?.role || ""),
    capabilities: Object.freeze([...capabilities]),
    intent: responseIntent
  });
}

export async function completeIntelliteConnectionCallback(options = {}) {
  const callback = trustedUrl(options.callbackUrl, "callback URL");
  const state = callback.searchParams.get("state") || "";
  if (!state) fail("missing Intellite OAuth state", 400, "state_missing");
  const transactionStore = requiredTransactionStore(options.transactionStore);
  const transaction = await transactionStore.consume({ stateHash: await sha256(state) });
  if (!transaction) fail("invalid or replayed Intellite OAuth state", 400, "state_invalid");
  if (Date.parse(transaction.expiresAt) <= Date.now()) fail("Intellite OAuth transaction expired", 400, "transaction_expired");
  if (!callbackMatchesRedirect(callback.toString(), transaction.redirectUri)) fail("Intellite callback URI mismatch", 400, "redirect_mismatch");
  if (transaction.intent !== "login") {
    if (typeof options.authorizeLocalActor !== "function") fail("local authorization callback is required", 503, "local_authorization_required");
    if (await options.authorizeLocalActor(transaction) !== true) fail("local actor is no longer authorized", 403, "local_actor_forbidden");
  }
  const oauthError = callback.searchParams.get("error");
  if (oauthError) fail("Intellite connection was not approved", 403, oauthError);
  const code = callback.searchParams.get("code") || "";
  if (!code) fail("missing Intellite authorization code", 400, "code_missing");

  const fetchImpl = options.fetchImpl || fetch;
  const metadata = await oauthMetadata(transaction.issuer, fetchImpl);
  const tokenResponse = await fetchImpl(metadata.tokenEndpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: transaction.codeVerifier,
      client_id: transaction.appId,
      redirect_uri: transaction.redirectUri
    }),
    redirect: "error"
  });
  if (!tokenResponse.ok) fail("Intellite authorization code exchange failed", 401, "code_exchange_failed");
  const tokenBody = await tokenResponse.json();
  const accessToken = String(tokenBody?.access_token || "");
  const expiresIn = Number(tokenBody?.expires_in || 0);
  if (!accessToken || tokenBody?.token_type !== "Bearer" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    fail("Intellite token response is invalid", 401, "token_response_invalid");
  }
  const identity = verifiedIdentity(await fetchUserInfo(metadata, accessToken, fetchImpl), transaction);
  let localUserId = transaction.localUserId;
  let localTenantId = transaction.localTenantId;
  if (transaction.intent === "login") {
    if (typeof options.resolveExistingLoginMapping !== "function") {
      fail("existing login mapping resolver is required", 503, "login_mapping_resolver_required");
    }
    const mapping = await options.resolveExistingLoginMapping(identity);
    localUserId = normalizedLocalId(mapping?.localUserId, "mapped local user ID");
    localTenantId = normalizedLocalId(mapping?.localTenantId, "mapped local tenant ID");
    if (!mapping || mapping.status !== "active" || !localUserId || !localTenantId) {
      fail("no active existing-app mapping was found", 403, "login_mapping_missing");
    }
  }
  return Object.freeze({
    identity,
    transaction: Object.freeze({
      localUserId,
      localTenantId,
      returnTo: transaction.returnTo,
      intent: transaction.intent
    }),
    token: Object.freeze({ accessToken, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() })
  });
}

export async function revalidateIntelliteConnection(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const metadata = await oauthMetadata(options.issuer, fetchImpl);
  const transaction = {
    appId: String(options.appId || INTELLITE_APP_ID),
    capabilities: normalizedCapabilities(options.capabilities),
    intent: normalizedIntent(options.intent || "login")
  };
  const identity = verifiedIdentity(await fetchUserInfo(metadata, String(options.accessToken || ""), fetchImpl), transaction);
  if (options.intelliteUserId && identity.intelliteUserId !== String(options.intelliteUserId)) fail("Intellite user mapping changed", 403, "user_mapping_mismatch");
  if (options.intelliteOrgId && identity.intelliteOrgId !== String(options.intelliteOrgId)) fail("Intellite organization mapping changed", 403, "organization_mapping_mismatch");
  return identity;
}

export async function revokeIntelliteConnection(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const metadata = await oauthMetadata(options.issuer, fetchImpl);
  const accessToken = String(options.accessToken || "");
  if (!accessToken) fail("Intellite access token is required", 400, "access_token_required");
  const response = await fetchImpl(metadata.revocationEndpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: accessToken, client_id: String(options.appId || INTELLITE_APP_ID) }),
    redirect: "error"
  });
  if (!response.ok) fail("Intellite token revocation failed", 503, "revocation_failed");
  return true;
}
`;
}

function proxyVerifierModuleTemplateTail() {
  return `
function fail(message, status = 401) {
  throw new IntelliteProxyVerificationError(message, status);
}

function base64url(bytes) {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
}

function decodeBase64url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function trustedJwksUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    fail("invalid Intellite JWKS URL", 503);
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) fail("unsafe Intellite JWKS URL", 503);
  return url.toString();
}

async function verificationKey(jwksUrl, keyId) {
  const safeUrl = trustedJwksUrl(jwksUrl);
  const cacheKey = safeUrl + "#" + keyId;
  const cached = jwksCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.key;
  const response = await fetch(safeUrl, { headers: { Accept: "application/json" }, redirect: "error" });
  if (!response.ok) fail("Intellite JWKS is unavailable", 503);
  const body = await response.json();
  const jwk = Array.isArray(body?.keys) ? body.keys.find((item) => item?.kid === keyId && item?.alg === "ES256") : null;
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.d) fail("Intellite verification key was not found", 503);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  jwksCache.set(cacheKey, { key, expiresAt: Date.now() + 5 * 60 * 1000 });
  return key;
}

function decodeClaims(encodedClaims) {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64url(encodedClaims)));
  } catch {
    fail("invalid Intellite proxy claims");
  }
}

async function verifyIntelliteProxyRequestInternal(request, options = {}, consumeReplay = true) {
  const appId = String(options.appId || INTELLITE_APP_ID);
  const requiredCapability = String(options.requiredCapability || "");
  const maxClockSkewSeconds = Number(options.maxClockSkewSeconds || 300);
  if (!appId || !requiredCapability) fail("Intellite verifier configuration is incomplete", 503);

  const algorithm = request.headers.get("x-intellite-proxy-algorithm") || "";
  const keyId = request.headers.get("x-intellite-proxy-key-id") || "";
  const timestamp = request.headers.get("x-intellite-proxy-timestamp") || "";
  const signature = request.headers.get("x-intellite-proxy-signature") || "";
  const bodySha256 = request.headers.get("x-intellite-proxy-body-sha256") || "";
  const encodedClaims = request.headers.get("x-intellite-proxy-claims") || "";
  if (algorithm !== "ES256" || !keyId || !timestamp || !signature || !bodySha256 || !encodedClaims) {
    fail("missing Intellite proxy signature headers");
  }

  const now = Math.floor(Date.now() / 1000);
  if (!/^\\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > maxClockSkewSeconds) {
    fail("stale Intellite proxy timestamp");
  }

  const rawBody = await request.clone().arrayBuffer();
  const actualBodySha256 = base64url(await crypto.subtle.digest("SHA-256", rawBody));
  if (actualBodySha256 !== bodySha256) fail("invalid Intellite proxy body hash");

  const url = new URL(request.url);
  const payload = [timestamp, request.method.toUpperCase(), url.pathname, url.search, bodySha256, encodedClaims].join("\\n");
  const key = await verificationKey(options.jwksUrl, keyId);
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    decodeBase64url(signature),
    new TextEncoder().encode(payload)
  );
  if (!verified) fail("invalid Intellite proxy signature");

  const claims = decodeClaims(encodedClaims);
  if (claims.aud !== INTELLITE_PROXY_AUDIENCE || claims.appId !== appId) fail("invalid Intellite proxy audience");
  if (claims.method !== request.method.toUpperCase() || claims.path !== url.pathname || claims.query !== url.search) {
    fail("invalid Intellite proxy target");
  }
  if (!Number.isFinite(claims.iat) || claims.iat > now + maxClockSkewSeconds) fail("invalid Intellite proxy issued-at time");
  if (!Number.isFinite(claims.exp) || claims.exp < now) fail("expired Intellite proxy claims");
  if (!claims.jti || !claims.userId || !claims.orgId) fail("incomplete Intellite proxy identity");
  if (!Array.isArray(claims.capabilities) || !claims.capabilities.includes(requiredCapability)) {
    fail("missing Intellite capability", 403);
  }

  if (consumeReplay && WRITE_METHODS.has(request.method.toUpperCase())) {
    if (!options.replayStore || typeof options.replayStore.consume !== "function") {
      fail("durable Intellite replay protection is not configured", 503);
    }
    const consumed = await options.replayStore.consume({
      jti: claims.jti,
      expiresAt: claims.exp,
      appId,
      orgId: claims.orgId,
      userId: claims.userId,
      method: claims.method,
      path: claims.path
    });
    if (!consumed) fail("replayed Intellite proxy request");
  }

  return Object.freeze({
    userId: claims.userId,
    userEmail: claims.userEmail || "",
    orgId: claims.orgId,
    capabilities: Object.freeze([...claims.capabilities]),
    agentTokenId: claims.agentTokenId || "",
    jti: claims.jti,
    issuedAt: claims.iat,
    expiresAt: claims.exp
  });
}

export async function verifyIntelliteProxyRequest(request, options = {}) {
  return verifyIntelliteProxyRequestInternal(request, options, true);
}

function requiredConnectionStore(store) {
  if (!store || typeof store.findOrganizationLink !== "function" || typeof store.findUserLink !== "function") {
    fail("Intellite connection mapping store is not configured", 503);
  }
  return store;
}

async function consumeIntelliteReplay(request, options, identity) {
  if (!WRITE_METHODS.has(request.method.toUpperCase())) return;
  if (!options.replayStore || typeof options.replayStore.consume !== "function") {
    fail("durable Intellite replay protection is not configured", 503);
  }
  const url = new URL(request.url);
  const consumed = await options.replayStore.consume({
    jti: identity.jti,
    expiresAt: identity.expiresAt,
    appId: String(options.appId || INTELLITE_APP_ID),
    orgId: identity.orgId,
    userId: identity.userId,
    method: request.method.toUpperCase(),
    path: url.pathname
  });
  if (!consumed) fail("replayed Intellite proxy request");
}

export async function authorizeIntelliteProxyRequest(request, options = {}) {
  const identity = await verifyIntelliteProxyRequestInternal(request, options, false);
  const connectionStore = requiredConnectionStore(options.connectionStore);
  const organizationLink = await connectionStore.findOrganizationLink({ intelliteOrgId: identity.orgId });
  if (!organizationLink || organizationLink.status !== "active" || !organizationLink.localTenantId) {
    fail("Intellite organization is not linked to an active local tenant", 403);
  }
  const userLink = await connectionStore.findUserLink({
    intelliteUserId: identity.userId,
    intelliteOrgId: identity.orgId,
    localTenantId: String(organizationLink.localTenantId)
  });
  if (
    !userLink ||
    userLink.status !== "active" ||
    !userLink.localUserId ||
    String(userLink.localTenantId || organizationLink.localTenantId) !== String(organizationLink.localTenantId)
  ) {
    fail("Intellite user is not linked to an active local user", 403);
  }
  if (typeof options.authorizeLocalAccess !== "function") {
    fail("existing-app role and ACL authorization is not configured", 503);
  }
  const localAccess = Object.freeze({
    localTenantId: String(organizationLink.localTenantId),
    localUserId: String(userLink.localUserId),
    requiredCapability: String(options.requiredCapability || ""),
    method: request.method.toUpperCase(),
    path: new URL(request.url).pathname,
    identity
  });
  if (await options.authorizeLocalAccess(localAccess) !== true) {
    fail("existing-app role or ACL denied this operation", 403);
  }
  await consumeIntelliteReplay(request, options, identity);
  return Object.freeze({ ...identity, ...localAccess });
}
`;
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
5. Run \`npx intellite --env staging app probe intellite.app.json\` against the published staging app.
6. Request production with \`npx intellite --env staging app request-production-review intellite.app.json\`. Production activation is review-gated.

## Manifest Rules

- Use \`schemaVersion: 2\` for resources, actions, and events.
- Keep capabilities narrow. A role should contain only the capabilities it needs.
- Do not declare root catch-all proxy routes.
- Do not declare broad write proxy routes for external apps.
- Actions with \`risk: "external_send"\` or \`risk: "destructive"\` must use \`approval: "confirm"\` or \`approval: "admin"\`.
- Missing skill signatures are acceptable locally. Intellite signs unsigned skill packages during publish and production review when platform signing is configured.

## App Implementation Requirements

- Implement a usage-guide endpoint and declare it in \`proxyRoutes\`.
- Import \`intellite/intellite-proxy.mjs\` in every Intellite-exposed route and authorize \`X-Intellite-Proxy-*\` ES256 claims against active local mappings and the existing app role/ACL.
- Use \`intellite/intellite-oauth.mjs\` for account linking. Keep state and PKCE transactions server-side and never link identities by email.
- Enforce both the signed Intellite capability and the existing app role/ACL on each request.
- Reject stale timestamps, expired claims, body hash mismatches, and replayed request IDs.
- Never use sample identities, unsigned \`X-Intellite-*\` headers, test organization IDs, or display names as production authority.

See \`.intellite/examples/usage-guide.md\`, \`.intellite/examples/proxy-signature-verification.md\`, \`.intellite/examples/oauth-connection.md\`, and the generated modules under \`intellite/\`.
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

- Require \`X-Intellite-Proxy-Algorithm: ES256\` and resolve \`X-Intellite-Proxy-Key-Id\` through Intellite's JWKS endpoint.
- Verify \`X-Intellite-Proxy-Signature\` with the matching P-256 public key. External apps do not receive a shared signing secret.
- Build the signature payload as \`timestamp + "\\n" + method + "\\n" + pathname + "\\n" + search + "\\n" + bodySha256 + "\\n" + claims\`.
- Verify \`X-Intellite-Proxy-Body-Sha256\` against the raw request body bytes.
- Decode \`X-Intellite-Proxy-Claims\` as base64url JSON and check \`aud\`, \`appId\`, \`method\`, \`path\`, \`query\`, \`exp\`, \`jti\`, and \`capabilities\`.
- Reject stale timestamps.
- For state-changing methods, atomically consume \`jti\` values in durable storage until at least the claim expiry.
- Check the declared capability before reading or writing app data.
- Fail closed on missing headers, unavailable JWKS, signature mismatch, stale timestamp, replay, or insufficient capability.

Generated verifier and existing-app authorization:

\`\`\`js
import { authorizeIntelliteProxyRequest } from "../../intellite/intellite-proxy.mjs";

const actor = await authorizeIntelliteProxyRequest(request, {
  appId: "${appId}",
  jwksUrl: process.env.INTELLITE_JWKS_URL,
  requiredCapability: "${appId}.read",
  replayStore,
  connectionStore: {
    findOrganizationLink: ({ intelliteOrgId }) => db.intelliteOrgLinks.findActive(intelliteOrgId),
    findUserLink: ({ intelliteUserId, localTenantId }) =>
      db.intelliteUserLinks.findActive(intelliteUserId, localTenantId)
  },
  authorizeLocalAccess: ({ localTenantId, localUserId, requiredCapability }) =>
    existingAppAcl.allows({ localTenantId, localUserId, requiredCapability })
});
\`\`\`

The mapping lookups and ACL callback must use the app's authoritative database. Missing mappings, disabled users, disabled tenants, and denied roles return an error. Do not bypass this by trusting display names, email text, or unsigned local development headers.
`
    },
    {
      path: `${APP_GUIDANCE_DIR}/examples/oauth-connection.md`,
      content: `<!-- intellite-app-guidance-version: ${APP_GUIDANCE_VERSION} -->
# Existing-App OAuth Connection

Use \`intellite/intellite-oauth.mjs\` from server routes only. The adapter does not edit routes, run migrations, create users, or write mappings.

Required app-owned interfaces:

- \`transactionStore.create(transaction)\`: durably stores a unique state hash and encrypted PKCE verifier.
- \`transactionStore.consume({ stateHash })\`: atomically returns and consumes one unexpired transaction.
- \`authorizeLocalActor(transaction)\`: confirms that the current local session still owns the stored local user and tenant. For \`install\`, require a local tenant administrator.

Start a connection:

\`\`\`js
const { authorizationUrl } = await createIntelliteConnectionRequest({
  issuer: process.env.INTELLITE_ISSUER,
  redirectUri: process.env.INTELLITE_REDIRECT_URI,
  intent: "link",
  capabilities: ["${appId}.read"],
  localUserId: session.user.id,
  localTenantId: session.tenant.id,
  returnTo: "/settings/integrations",
  transactionStore
});
\`\`\`

Complete the callback while the existing app session is still authenticated:

\`\`\`js
const result = await completeIntelliteConnectionCallback({
  callbackUrl: request.url,
  transactionStore,
  authorizeLocalActor: async (transaction) =>
    transaction.localUserId === session.user.id && transaction.localTenantId === session.tenant.id
});

// Persist stable result.identity.intelliteUserId and intelliteOrgId only after
// enforcing unique mapping constraints in the app database.
\`\`\`

For \`intent: "login"\`, do not pass a local actor from browser input. Supply \`resolveExistingLoginMapping(identity)\`; it must return an active pre-existing local user and tenant mapping. Missing mappings fail closed, and email equality is never a login mapping.

The returned access token is short-lived connection evidence, not an app session. Revoke it after the mapping transaction unless the server deliberately needs immediate revalidation. Normal browser use continues with the existing app session, and AI/CLI requests use fresh signed app-call tickets.

Never put the PKCE verifier, local user ID, local tenant ID, access token, or return URL in browser storage or an unsigned state value. Do not create or relink an account from email equality.
`
    },
    {
      path: "intellite/intellite-proxy.mjs",
      content: proxyVerifierModuleTemplate(appId)
    },
    {
      path: "intellite/intellite-oauth.mjs",
      content: oauthConnectionModuleTemplate(appId)
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

const PROJECT_SCAN_IGNORED_DIRS = new Set([".git", ".intellite", ".next", ".wrangler", "node_modules", "dist", "build", "coverage", "vendor"]);
const PROJECT_SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rb", ".go", ".java", ".cs"]);

async function optionalTextFile(filePath) {
  try {
    return await readTextFileNoSymlink(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function projectSourceFiles(projectRoot, limit = 3000) {
  const files = [];
  const stack = [projectRoot];
  while (stack.length > 0 && files.length < limit) {
    const directory = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!PROJECT_SCAN_IGNORED_DIRS.has(entry.name)) stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !PROJECT_SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const relativePath = projectRelativePath(projectRoot, fullPath);
      if (
        relativePath === "intellite/intellite-proxy.mjs" ||
        relativePath === "intellite/intellite-oauth.mjs" ||
        /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(relativePath)
      ) continue;
      const stats = await fs.stat(fullPath);
      if (stats.size > 512 * 1024) continue;
      files.push({ path: relativePath, fullPath });
      if (files.length >= limit) break;
    }
  }
  return files;
}

async function implementationEvidence(projectRoot, manifest) {
  const files = await projectSourceFiles(projectRoot);
  const matched = new Set();
  let verifier = false;
  let usageGuide = false;
  let capability = false;
  let replay = false;
  let localAuthorization = false;
  let oauthStart = false;
  let oauthCallback = false;
  let oauthTransactionStore = false;
  let oauthLocalActor = false;
  for (const file of files) {
    const content = await optionalTextFile(file.fullPath);
    const hasVerifier = /(?:verify|authorize)IntelliteProxyRequest\s*\(/.test(content) || (
      /x-intellite-proxy-signature/i.test(content) &&
      /x-intellite-proxy-claims/i.test(content) &&
      /(?:subtle\.verify|createHmac)/.test(content)
    );
    const hasUsageGuide = /(?:\/api\/)?usage-guide/.test(content);
    const hasCapability = /requiredCapability\s*:/.test(content) || /x-intellite-capabilities/i.test(content);
    const hasReplay = /(?:replay.{0,80}jti|jti.{0,80}replay|consume.{0,80}jti)/is.test(content);
    const hasLocalAuthorization = /authorizeIntelliteProxyRequest\s*\(/.test(content) &&
      /connectionStore/.test(content) &&
      /authorizeLocalAccess/.test(content);
    const hasOAuthStart = /createIntelliteConnectionRequest\s*\(/.test(content);
    const hasOAuthCallback = /completeIntelliteConnectionCallback\s*\(/.test(content);
    const hasOAuthTransactionStore = /transactionStore/.test(content) && /(?:consume|create)\s*[:.(]/.test(content);
    const hasOAuthLocalActor = /completeIntelliteConnectionCallback\s*\([\s\S]{0,1600}authorizeLocalActor\s*:/m.test(content);
    if (hasVerifier || hasUsageGuide || hasCapability || hasReplay || hasLocalAuthorization || hasOAuthStart || hasOAuthCallback || hasOAuthTransactionStore || hasOAuthLocalActor) matched.add(file.path);
    verifier ||= hasVerifier;
    usageGuide ||= hasUsageGuide;
    capability ||= hasCapability;
    replay ||= hasReplay;
    localAuthorization ||= hasLocalAuthorization;
    oauthStart ||= hasOAuthStart;
    oauthCallback ||= hasOAuthCallback;
    oauthTransactionStore ||= hasOAuthTransactionStore;
    oauthLocalActor ||= hasOAuthLocalActor;
  }
  const hasWriteRoute = (manifest?.proxyRoutes ?? []).some((route) => WRITE_ROUTE_METHODS.has(textValue(route.method || "*").toUpperCase()));
  const hasOAuthRedirect = APP_ENVIRONMENTS.some((environment) => arrayText(recordValue(manifest?.environments?.[environment])?.oauthRedirectUris).length > 0);
  return {
    checks: [
      { name: "implementation:proxy-verifier-integrated", ok: verifier, status: verifier ? "detected" : "missing" },
      { name: "implementation:usage-guide-endpoint", ok: usageGuide, status: usageGuide ? "detected" : "missing" },
      { name: "implementation:capability-enforcement", ok: capability, status: capability ? "detected" : "missing" },
      { name: "implementation:existing-app-role-acl", ok: localAuthorization, status: localAuthorization ? "detected" : "missing" },
      { name: "implementation:durable-replay-store", ok: !hasWriteRoute || replay, status: hasWriteRoute ? (replay ? "detected" : "missing") : "not_applicable" },
      {
        name: "implementation:oauth-connection",
        ok: !hasOAuthRedirect || (oauthStart && oauthCallback && oauthTransactionStore && oauthLocalActor),
        status: hasOAuthRedirect ? (oauthStart && oauthCallback && oauthTransactionStore && oauthLocalActor ? "detected" : "missing") : "not_applicable"
      }
    ],
    evidenceFiles: [...matched].sort()
  };
}

function manifestFingerprint(manifest) {
  return sha256Hex(JSON.stringify(manifest));
}

function probeResultPath(projectRoot) {
  return path.join(projectRoot, APP_GUIDANCE_DIR, "probe-result.json");
}

async function readProbeResult(projectRoot) {
  try {
    return recordValue(JSON.parse(await readTextFileNoSymlink(probeResultPath(projectRoot))));
  } catch {
    return null;
  }
}

function currentProbeCheck(projectRoot, manifest, probe) {
  const current = Boolean(
    probe &&
    probe.ok === true &&
    textValue(probe.appId) === manifest.appId &&
    textValue(probe.version) === manifest.version &&
    textValue(probe.manifestFingerprint) === manifestFingerprint(manifest) &&
    textValue(probe.environment) === "staging" &&
    Date.now() - Date.parse(textValue(probe.checkedAt)) <= 7 * 24 * 60 * 60 * 1000
  );
  return {
    name: "runtime:staging-probe-current",
    ok: current,
    status: current ? "current" : probe ? "stale_or_failed" : "missing",
    path: projectRelativePath(projectRoot, probeResultPath(projectRoot))
  };
}

function safeAdoptedAppId(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 80);
  return APP_ID_PATTERN.test(normalized) ? normalized : "existing-business-app";
}

async function projectPackageMetadata(projectRoot) {
  try {
    const packageJson = await readJsonFile(path.join(projectRoot, "package.json"));
    const dependencies = { ...recordValue(packageJson.dependencies), ...recordValue(packageJson.devDependencies) };
    return {
      name: textValue(packageJson.name),
      dependencies: new Set(Object.keys(dependencies))
    };
  } catch {
    return { name: "", dependencies: new Set() };
  }
}

async function detectProjectFramework(projectRoot, metadata) {
  const dependencies = metadata.dependencies;
  if (dependencies.has("next")) return "nextjs";
  if (dependencies.has("hono")) return "hono";
  if (dependencies.has("express")) return "express";
  if (dependencies.has("fastify")) return "fastify";
  const python = `${await optionalTextFile(path.join(projectRoot, "requirements.txt"))}\n${await optionalTextFile(path.join(projectRoot, "pyproject.toml"))}`.toLowerCase();
  if (python.includes("fastapi")) return "fastapi";
  if (python.includes("django")) return "django";
  if (python.includes("flask")) return "flask";
  const gemfile = (await optionalTextFile(path.join(projectRoot, "Gemfile"))).toLowerCase();
  if (/gem\s+["']rails["']/.test(gemfile)) return "rails";
  if (await optionalTextFile(path.join(projectRoot, "wrangler.toml")) || await optionalTextFile(path.join(projectRoot, "wrangler.jsonc"))) return "cloudflare-worker";
  return "unknown";
}

async function detectedRouteCandidates(projectRoot) {
  const files = await projectSourceFiles(projectRoot, 1500);
  const candidates = [];
  const seen = new Set();
  for (const file of files) {
    const content = await optionalTextFile(file.fullPath);
    const routePattern = /\b(?:app|router|server)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
    for (const match of content.matchAll(routePattern)) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      const key = `${method}\u0000${routePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ method, path: routePath, file: file.path, status: "review_required" });
    }
    const nextMatch = file.path.match(/^(?:src\/)?app\/api\/(.+)\/route\.(?:js|jsx|mjs|ts|tsx)$/i);
    if (nextMatch) {
      const routePath = `/api/${nextMatch[1].replace(/\[([^\]]+)\]/g, ":$1")}`;
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (!new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b|export\\s+const\\s+${method}\\b`).test(content)) continue;
        const key = `${method}\u0000${routePath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ method, path: routePath, file: file.path, status: "review_required" });
      }
    }
  }
  return candidates.slice(0, 200);
}

function adoptedAppManifest({ appId, name, localUrl, stagingUrl, productionUrl }) {
  return {
    schemaVersion: 2,
    appId,
    name,
    description: `${name} connected to Intellite.`,
    version: "0.1.0",
    visibility: "private",
    capabilities: [
      { id: `${appId}.read`, label: "Read" },
      { id: `${appId}.write`, label: "Write" },
      { id: `${appId}.admin`, label: "Admin" }
    ],
    roles: [
      { id: "viewer", label: "Viewer", capabilities: [`${appId}.read`], default: true },
      { id: "member", label: "Member", capabilities: [`${appId}.read`, `${appId}.write`] },
      { id: "admin", label: "Admin", capabilities: [`${appId}.read`, `${appId}.write`, `${appId}.admin`] }
    ],
    environments: {
      local: {
        appBaseUrl: localUrl,
        proxyBaseUrl: localUrl,
        oauthRedirectUris: [new URL("/api/auth/intellite/callback", localUrl).toString()]
      },
      staging: {
        appBaseUrl: stagingUrl,
        proxyBaseUrl: stagingUrl,
        oauthRedirectUris: [new URL("/api/auth/intellite/callback", stagingUrl).toString()]
      },
      production: {
        appBaseUrl: productionUrl,
        proxyBaseUrl: productionUrl,
        oauthRedirectUris: [new URL("/api/auth/intellite/callback", productionUrl).toString()]
      }
    },
    proxyRoutes: [{
      routeId: "usage-guide-read",
      method: "READ",
      publicPathPattern: "^/usage-guide$",
      upstreamPathReplacement: "/api/usage-guide",
      capabilities: [`${appId}.read`],
      sort: 10
    }],
    skills: [{
      name: appId.replace(/[.:]/g, "-").slice(0, 64),
      displayName: name,
      description: `Operate ${name} through Intellite.`,
      version: "0.1.0",
      requiredCapabilities: [`${appId}.read`],
      files: [{ path: "SKILL.md", content: `# ${name}\n\nUse Intellite app paths for ${appId}. Read /usage-guide before operating the app.\n` }]
    }],
    resources: [],
    actions: [],
    events: [],
    usageGuide: { path: "/api/usage-guide", format: "markdown" },
    lifecycle: { productionReviewRequired: true }
  };
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

async function appDirectTicket(pathname, options = {}) {
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
  return { url, headers, method, rawBody };
}

async function appDirectFetch(pathname, options = {}) {
  const ticket = await appDirectTicket(pathname, options);
  return fetch(ticket.url, {
    method: ticket.method,
    headers: ticket.headers,
    body: ticket.method === "GET" || ticket.method === "HEAD" ? undefined : ticket.rawBody,
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

async function appAdopt(args) {
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
  const metadata = await projectPackageMetadata(projectRoot);
  const appId = safeAdoptedAppId(argValue(args, "--app-id", metadata.name));
  const name = textValue(argValue(args, "--name", metadata.name)) || appId;
  const localUrl = argValue(args, "--local-url", "http://localhost:3000");
  const stagingUrl = argValue(args, "--staging-url", `https://staging.${appId}.example.invalid`);
  const productionUrl = argValue(args, "--production-url", `https://${appId}.example.invalid`);
  const manifest = adoptedAppManifest({ appId, name, localUrl, stagingUrl, productionUrl });
  const validation = validateAppManifestObject(manifest);
  if (!validation.ok) {
    printManifestValidation(validation, filePath);
    process.exitCode = 1;
    return;
  }
  await fs.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  const guidance = await writeAppGuidance(projectRoot, manifest, { refresh: false });
  const framework = await detectProjectFramework(projectRoot, metadata);
  const routeCandidates = await detectedRouteCandidates(projectRoot);
  const report = {
    generatedAt: new Date().toISOString(),
    appId,
    framework,
    routeCandidates,
    automaticExposure: [],
    requiredActions: [
      "Replace any .example.invalid staging and production URLs in intellite.app.json.",
      "Import intellite/intellite-proxy.mjs in the app routes declared in proxyRoutes.",
      "Implement an app-owned durable OAuth transaction store before importing intellite/intellite-oauth.mjs.",
      "Add explicit install/link callback routes without changing the existing login route or user table.",
      "Implement GET /api/usage-guide and require the app read capability.",
      "Review routeCandidates and add only approved routes with narrow capabilities.",
      "Use an atomic durable replayStore.consume implementation for every state-changing route."
    ],
    jwks: {
      staging: `${ENVIRONMENTS.staging.baseUrl}/.well-known/intellite-app-proxy-jwks.json`,
      production: `${ENVIRONMENTS.production.baseUrl}/.well-known/intellite-app-proxy-jwks.json`
    }
  };
  const reportPath = assertProjectLocalPath(projectRoot, `${APP_GUIDANCE_DIR}/adoption-report.json`);
  await writeTextFileNoSymlink(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    filePath,
    appId,
    framework,
    routeCandidateCount: routeCandidates.length,
    reportPath,
    guidance,
    requiresUrlConfiguration: stagingUrl.endsWith(".example.invalid") || productionUrl.endsWith(".example.invalid")
  }, null, 2));
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
      return hostname === "example-app.example.com" || hostname === "staging.example-app.example.com" || hostname.endsWith(".example.invalid");
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
  const implementation = await implementationEvidence(path.dirname(filePath), result.manifest || manifest);
  const probeCheck = currentProbeCheck(path.dirname(filePath), result.manifest || manifest, await readProbeResult(path.dirname(filePath)));
  const checks = [
    { name: "manifest-valid", ok: result.ok },
    ...conformanceChecks,
    ...readyChecks,
    ...guidanceChecks,
    ...implementation.checks
  ];
  const ok = result.ok && checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    localReady: ok,
    runtimeReady: probeCheck.ok,
    productionReady: ok && probeCheck.ok,
    filePath,
    appId: result.manifest?.appId || "",
    version: result.manifest?.version || "",
    validation: { errors: result.errors, warnings: result.warnings },
    checks,
    implementationEvidenceFiles: implementation.evidenceFiles,
    runtimeChecks: [probeCheck]
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

async function appProbe(args) {
  if (activeEnvironment.name !== "staging") {
    throw new Error("app probe is staging-only. Run it with --env staging.");
  }
  const clean = withoutOptions(args, ["--path"]);
  const { filePath, manifest } = await readAppManifestFile(clean);
  const result = validateAppManifestObject(manifest);
  if (!result.ok || !result.manifest) {
    printManifestValidation(result, filePath);
    process.exitCode = 1;
    return;
  }
  const rawPublicPath = argValue(args, "--path", "/usage-guide");
  let parsedPublicPath;
  try {
    parsedPublicPath = new URL(rawPublicPath, "https://intellite.local");
  } catch {
    throw new Error("--path must be an app path such as /usage-guide.");
  }
  if (parsedPublicPath.origin !== "https://intellite.local" || !rawPublicPath.startsWith("/")) {
    throw new Error("--path must be a relative app path such as /usage-guide.");
  }
  const publicPath = parsedPublicPath.pathname;
  const route = result.manifest.proxyRoutes.find((candidate) => {
    const method = textValue(candidate.method || "*").toUpperCase();
    if (!["*", "READ", "GET", "HEAD"].includes(method)) return false;
    try {
      return new RegExp(textValue(candidate.publicPathPattern)).test(publicPath);
    } catch {
      return false;
    }
  });
  if (!route) throw new Error(`No read-only proxy route matches ${publicPath}.`);

  let serverProbe;
  try {
    const response = await authenticatedRequest("/api/organization/developer/apps/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: result.manifest.appId,
        version: result.manifest.version,
        environment: "staging",
        publicPath: `${publicPath}${parsedPublicPath.search}`
      })
    });
    serverProbe = response.body;
  } catch (error) {
    if (!recordValue(error?.body)) throw error;
    serverProbe = error.body;
  }
  const probe = {
    ...recordValue(serverProbe),
    manifestFingerprint: manifestFingerprint(result.manifest)
  };
  const projectRoot = path.dirname(filePath);
  const outputPath = probeResultPath(projectRoot);
  await ensureDirectoryNoSymlink(path.dirname(outputPath), projectRoot);
  await writeTextFileNoSymlink(outputPath, `${JSON.stringify(probe, null, 2)}\n`);
  console.log(JSON.stringify({ ...probe, filePath, outputPath }, null, 2));
  if (probe.ok !== true) process.exitCode = 1;
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
  const probeCheck = currentProbeCheck(path.dirname(filePath), result.manifest, await readProbeResult(path.dirname(filePath)));
  if (!probeCheck.ok) {
    console.log(JSON.stringify({
      ok: false,
      filePath,
      appId: result.manifest?.appId || "",
      version: result.manifest?.version || "",
      errors: [manifestIssue("$ runtime:staging-probe-current", "Run a successful current staging app probe before requesting production review.")],
      checks: [probeCheck]
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
  app adopt [--output intellite.app.json] [--app-id APP_ID] [--name NAME]
  app validate [FILE]
  app conformance [FILE]
  app refresh [FILE]
  app doctor [FILE]
  app probe [FILE] [--path /usage-guide]
  app list
  app publish [FILE] --app-env staging
  app request-production-review [FILE]
`);
    return;
  }
  if (subcommand === "init") return appInit(rest);
  if (subcommand === "adopt") return appAdopt(rest);
  if (subcommand === "validate") return appValidate(rest);
  if (subcommand === "conformance") return appConformance(rest);
  if (subcommand === "refresh") return appRefresh(rest);
  if (subcommand === "doctor") return appDoctor(rest);
  if (subcommand === "probe") return appProbe(rest);
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
