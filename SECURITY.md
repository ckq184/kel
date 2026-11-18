# Security Notes

## Input parsing trust boundary

The Claude Code plugin system (and with it the `yaml`-based plugin command
frontmatter parser described in earlier revisions of this file) has been
removed from the codebase (2026-11-18, see `docs/plugin-prune-plan.md`).

Standing rule:

- Server code must **not** parse user-supplied YAML (or other structured
  formats beyond JSON) from:
  - Web UI request bodies
  - IM channel messages (Feishu, QQ, WeChat)
  - Any HTTP API request body

If a future code path adds such parsing, that path must be reviewed
independently — past parser trust boundaries do not license exposing new
ones to untrusted input.

## Secrets handling

- Secrets and environment variable values must never be written into code,
  logs, docs, or events (`AGENTS.md` §2 敏感区域).
- The pre-commit hook scans staged lines for secret patterns; the pattern
  truth source is the repository redact implementation, with allowlist
  entries limited to fake-key fixtures and the redact implementation itself
  (`.gatesecretsignore`).
