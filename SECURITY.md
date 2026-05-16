# Security Policy

## Supported Package

Only the latest published `intellite` CLI release is supported.

## Reporting a Vulnerability

Report suspected vulnerabilities privately to the project maintainer. Do not open public issues containing tokens, secrets, exploit details, or customer data.

## Local Token Storage

The CLI stores Intellite access tokens in the most protected local store available:

- Windows: DPAPI encrypted token file bound to the current Windows user.
- macOS: Keychain generic password.
- Linux: Secret Service through `secret-tool`, when available.
- Fallback: `~/.intellite/config.json` with user-only file permissions, with a warning.

For stricter environments, set `INTELLITE_TOKEN_STORE=secure`. Login then fails instead of falling back to file storage when no OS credential store is available.

`INTELLITE_TOKEN` can be used for ephemeral automation and is never written to disk by the CLI.

These protections reduce accidental disclosure and cross-user file access. They do not protect a token from malware, an interactive attacker already running as the same OS user, or a compromised Intellite account. Server-side token revocation and short-lived app-permission tokens remain required controls.
