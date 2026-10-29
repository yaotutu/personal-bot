---
name: skill-creator
description: Create, inspect, and safely revise Pi Muse skills through the skills tool with manual approval.
---
# Pi Muse skill authoring

Use the `skills` tool only for product skill maintenance requested explicitly by the user. Do not use it to create Codex development skills.

## Tool contract

- `action="list"` returns all skills visible in the current space with `name`, `description`, `source` (`builtin` or `user`), default state, and current effective state. It never returns server paths.
- `action="read"` requires `name` and optionally `file`. It can read installed or disabled skills so they can be edited. Allowed files are `SKILL.md` and UTF-8 text resources under `references/` or `assets/` with `.md`, `.txt`, `.json`, `.csv`, `.yaml`, or `.yml` extensions.
- `action="save"` requires `name`, optionally `file`, and complete `content`. It replaces exactly one UTF-8 file of at most 100KB. Every save requires human approval and revalidates the bound file version before commit. If approval is denied, expires, is cancelled, or the file changes, do not resend automatically; inspect the current state first.

`name` must contain only lowercase letters, digits, and single hyphens and be at most 64 characters. `SKILL.md` must parse with the installed pi SDK and its frontmatter `name` must match the directory. A save never edits built-in assets: saving a built-in name creates an instance-level override.

## Authoring workflow

1. Read the existing skill and relevant resources before revising it.
2. Draft a focused `SKILL.md` with a precise `description`, explicit prerequisites, step-by-step instructions, permission limits, and failure handling.
3. Put longer reference material in `references/` and reusable text data in `assets/`; do not place another `SKILL.md` there. Save a valid instance `SKILL.md` before saving its resources. Never create or modify `config.json`, `extension.ts`, scripts, binaries, or directories.
4. Submit a complete file through `skills` and show the user the resulting approval preview. Wait for the human decision.
5. After approval, report the saved file, default state, and current-space enabled state. Saved or overridden skills load on the next model turn; the current turn does not gain their new instructions or extensions.

The system initializes a new instance skill with `defaultEnabled: false`; it does not silently enable it globally or for the current space. The user may enable it through the existing per-space skill switch.

## Safety

Do not store credentials or secrets in skills. Do not claim that skill text is a sandbox: `extension.ts` is trusted server code and is intentionally outside this authoring tool. Product subagents do not receive the `skills` tool.
