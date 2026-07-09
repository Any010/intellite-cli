# Intellite CLI

Command line client for Intellite. `npx intellite` is the local agent runtime for end-user AI assistants and the developer SDK/CLI for Intellite Apps.

For general end-user AI agent operation, use the local `intellite agent ...` commands. They sync app-specific skills to this machine, exchange authorized app API paths for signed direct app calls, and save files such as PDFs directly into the local workspace.

The CLI connects to `https://intellite.app` by default and uses a browser-based device authorization flow. Do not give your Intellite password to an AI assistant or script.

Intellite is the authentication and API access layer. App-specific capabilities are granted by the user's account, organization app entitlements, and installed Intellite skills. The base CLI does not include business-app commands by itself.

## Requirements

- Node.js 20 or later
- An active Intellite user account

## Local Agent Usage

```bash
npx intellite login
npx intellite agent setup
npx intellite agent status
npx intellite agent skills
npx intellite agent context
```

Staging uses the same CLI flow with an explicit environment option:

```bash
npx intellite --env staging login
npx intellite --env staging agent setup
npx intellite --env staging agent status
```

The login command reuses the existing local token when it is still valid and already contains the current app permissions. If no valid token exists, or if the user's app access has changed and the token is stale, it opens a browser approval page. After approval, an app-permission token is stored on the local machine. The CLI prefers the OS credential store and falls back to `~/.intellite/config.json` only when a credential store is not available.

After login, the CLI automatically syncs the Intellite skills available to the signed-in account into the local Intellite skills directory and, when present, Codex's local skill directory at `~/.codex/skills`. Codex copies are materialized with `name` and `description` frontmatter so future Codex sessions can discover app skills without the user naming Intellite. `intellite agent setup` refreshes that sync explicitly. Set `INTELLITE_SKILLS_DIR` for the Intellite-managed copy, `INTELLITE_CODEX_SKILLS_DIR` for a non-default Codex skill directory, or `INTELLITE_AGENT_SKILLS_DIRS` for additional agent skill directories separated by the OS path delimiter. Set `INTELLITE_SYNC_CODEX_SKILLS=0` only when intentionally disabling Codex skill sync. The npm package itself does not include app-specific skills.

Skills can include platform defaults plus Intellite custom instructions. Organization overlays, personal overlays, and standalone custom skills are delivered by `/api/intellite/skills` and written by `intellite agent setup` into the same managed skill directory. Custom instructions can narrow workflow choices and add organization-specific usage guidance, but they do not grant permissions or override Intellite security rules.

## Commands

```bash
npx intellite login [--name "AI assistant on this PC"] [--force]
npx intellite agent setup
npx intellite agent status
npx intellite agent skills
npx intellite agent context
npx intellite agent api GET /api/intellite/status
npx intellite agent api GET /api/intellite/apps/camera-estimate/audit-events --query limit=50 --query q=user
npx intellite agent api GET /api/intellite/apps/rental-car-management/workspace
npx intellite agent api POST /api/example --body input.json
npx intellite agent download /api/example/file --output output.bin
npx intellite status
npx intellite setup
npx intellite skills
npx intellite api GET /api/intellite/status
npx intellite download /api/example/file --output output.bin
npx intellite app init --output intellite.app.json
npx intellite app validate intellite.app.json
npx intellite app conformance intellite.app.json
npx intellite app refresh intellite.app.json
npx intellite app doctor intellite.app.json
npx intellite --env staging app publish intellite.app.json --app-env staging
npx intellite --env staging app list
npx intellite --env staging app request-production-review intellite.app.json
npx intellite logout
```

Use `--env staging` with the same commands when testing staging. Staging uses `~/.intellite/config.staging.json` and `~/.intellite/skills-staging` so production and staging tokens/skills do not mix.

App-specific API calls should use the stable Intellite app path shape:

```text
/api/intellite/apps/<app-id>/<app-path>
```

The CLI does not bypass Intellite app grants. For app paths, it asks Intellite for a short-lived signed app-call ticket, then sends the business request or file download directly to the app so Intellite does not carry the response body.

For files, use `agent download` against the same authenticated app path. This writes bytes on the user's machine from the app response; do not create public or short-lived browser URLs for a human to fetch.

By default, login requests the app permissions available to the signed-in account. Advanced callers can request a narrower token with `--permission APP_ID:CAPABILITY`. Use `--force` only when intentionally replacing the local connection; the previous local token is revoked after the new one is issued.

Skill sync can also be run explicitly:

```bash
npx intellite agent setup
```

## Developer App Workflow

The public CLI includes the developer app workflow:

```bash
npx intellite app init --output intellite.app.json
npx intellite app validate intellite.app.json
npx intellite app conformance intellite.app.json
npx intellite --env staging app publish intellite.app.json --app-env staging
npx intellite --env staging app list
npx intellite --env staging app request-production-review intellite.app.json
```

`init`, `validate`, `conformance`, `refresh`, and `doctor` are local checks. `publish --app-env staging` sends a validated manifest to the selected Intellite environment and registers the app for the signed-in organization. `request-production-review` stores a production manifest as pending review; it is not active until platform approval. Production publication is intentionally not self-service.
`app list` shows the manifest versions and environments registered for the signed-in developer organization.

`app init` scaffolds the current `schemaVersion: 2` manifest and project-local AI guidance under `.intellite/`. It does not write global skills or touch `~/.codex/skills`. The generated manifest contains sample app ID and sample URLs; replace them before running `app doctor`, `app publish`, or `app request-production-review`. In addition to capabilities, roles, environments, proxy routes, and skills, v2 manifests can declare:

- `resources`: typed objects the assistant can refer to with stable `intellite://apps/...` references.
- `actions`: callable operations with capability, risk, and approval metadata. `external_send` and `destructive` actions must require `confirm` or `admin`.
- `events`: app-emitted lifecycle or business events tied to resources.

If a skill package has no signature, local validation reports a warning. Intellite signs unsigned skill packages server-side during staging publish and production review when the platform signing secret is configured.

`app refresh` updates `.intellite/agent-guidance.md` and `.intellite/examples/` from the current CLI templates. Files that still match the last generated hash are updated in place. User-edited files are not overwritten; the new version is written next to them as `.new`.

`app doctor` runs manifest validation, conformance checks, sample-value readiness checks, and project-local guidance freshness checks. It also reports manual implementation checks such as `X-Intellite-Proxy-*` signature verification.

Planned additional SDK commands:

```bash
npx intellite app dev-link --env staging
npx intellite app agent-test --env staging
```

Production publishing requires Intellite review. Pending production manifests, environments, and skill packages are kept out of runtime resolution until approved.

## Security

- The CLI package contains no service secrets.
- The CLI package contains no app-specific skills.
- Tokens are stored only on the user's local machine. The CLI prefers Windows DPAPI, macOS Keychain, or Linux Secret Service.
- `logout` revokes the server-side token and removes the local config file.
- The CLI connects only to official Intellite endpoints selected by `--env production` or `--env staging`.
- Server-provided download filenames are sanitized before writing files locally.
- Prefer JSON files over inline `--json` arguments on Windows PowerShell.

## License

See `LICENSE`.
