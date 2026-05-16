# Intellite CLI

Command line client for Intellite AI assistant connections.

The CLI connects to `https://intellite.app` by default and uses a browser-based device authorization flow. Do not give your Intellite password to an AI assistant or script.

Intellite is the authentication and API access layer. App-specific capabilities are granted by the user's account, organization app entitlements, and installed Intellite skills. The base CLI does not include business-app commands by itself.

## Requirements

- Node.js 20 or later
- An active Intellite user account

## Usage

```bash
npx intellite login
npx intellite status
```

The login command reuses the existing local token when it is still valid and already contains the current app permissions. If no valid token exists, or if the user's app access has changed and the token is stale, it opens a browser approval page. After approval, an app-permission token is stored on the local machine. The CLI uses the OS credential store when available and keeps only non-secret metadata in `~/.intellite/config.json`.

After login, the CLI automatically syncs the Intellite skills available to the signed-in account into the local Intellite skills directory. Set `INTELLITE_SKILLS_DIR` when an AI assistant uses a specific local skill directory. The npm package itself does not include app-specific skills.

## Commands

```bash
npx intellite login [--name "AI assistant on this PC"] [--force]
npx intellite status
npx intellite setup
npx intellite skills
npx intellite logout
npx intellite api GET /api/intellite/status
npx intellite api GET /api/intellite/audit-events --query limit=50 --query q=user
npx intellite api POST /api/example --body input.json
npx intellite download /api/example/file --output output.bin
```

By default, login requests the app permissions available to the signed-in account. Advanced callers can request a narrower token with `--permission APP_ID:CAPABILITY`. Use `--force` only when intentionally replacing the local connection; the previous local token is revoked after the new one is issued.

Skill sync can also be run explicitly:

```bash
npx intellite setup
```

## Security

- The CLI package contains no service secrets.
- The CLI package contains no app-specific skills.
- Tokens are stored only on the user's local machine.
- The CLI uses the OS credential store when available: Windows DPAPI, macOS Keychain, or Linux Secret Service.
- If no OS credential store is available, the CLI falls back to `~/.intellite/config.json` with user-only file permissions and prints a warning.
- Set `INTELLITE_TOKEN_STORE=secure` to reject fallback file storage.
- Set `INTELLITE_TOKEN` for ephemeral automation without writing a token to disk.
- `logout` revokes the server-side token and removes the local token/config data.
- The CLI connects only to the production Intellite endpoint.
- Server-provided download filenames are sanitized before writing files locally.
- Prefer JSON files over inline `--json` arguments on Windows PowerShell.

## License

See `LICENSE`.
