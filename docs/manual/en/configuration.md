# pi-muse Configuration

pi-muse reads its startup configuration from exactly one file:

```text
.pi-muse/config.json
```

The file must exist. A missing file, JSON syntax error, unknown field, invalid type, or unknown `schemaVersion` causes startup to fail. The server does not support legacy environment-variable configuration or `${ENV_NAME}` interpolation. The model API key is written directly in `model.apiKey`. `API_TARGET` for the repository's own `web/` is used only by Vite's `/api` proxy and is not a server configuration source.

## Create the Configuration {#create-configuration}

~~~sh
mkdir -p .pi-muse
cp -n config.example.json .pi-muse/config.json
chmod 600 .pi-muse/config.json
~~~

Then edit it:

~~~json
{
  "schemaVersion": 1,
  "server": {
    "host": "0.0.0.0",
    "port": 17890,
    "accessKey": "",
    "allowedOrigins": [
      "http://localhost:15173",
      "http://127.0.0.1:15173"
    ]
  },
  "model": {
    "baseUrl": "http://127.0.0.1:8000/v1",
    "id": "my-model",
    "apiKey": "paste-model-api-key-here",
    "contextWindow": 32768,
    "maxTokens": 4096
  },
  "runtime": {
    "runTimeoutMs": 120000,
    "schedulerIntervalMs": 30000
  },
  "tools": {
    "writable": {
      "enabled": true,
      "actionTimeoutMs": 300000
    },
    "web": {
      "enabled": true
    },
    "weather": {
      "enabled": true,
      "defaultCity": "上海"
    },
    "browser": {
      "enabled": true,
      "allowPrivateTargets": false
    },
    "presentation": {
      "default": "hidden",
      "overrides": {
        "currentTime": "summary",
        "get_weather": "summary",
        "search_web": "summary",
        "memory": "summary",
        "schedule": "summary"
      }
    }
  }
}
~~~

Every section and field may be omitted as needed; omitted values use built-in defaults. `schemaVersion` is currently `1`.

## Field Reference {#field-reference}

| Field | Default | Description |
| --- | --- | --- |
| `server.host` | `0.0.0.0` | By default, listens on all network interfaces for convenient LAN access. A non-loopback host with an empty `server.accessKey` only prints a warning; the user decides whether to add one. |
| `server.port` | `17890` | HTTP listening port. If it is occupied, startup fails directly and reports the occupying PID when `lsof` can determine it, falling back to a generic message where cross-platform lookup is unavailable. Coordinate a restart only after confirming the process belongs to this project's development service; never stop a production or unidentified process on your own. |
| `server.accessKey` | Empty | Service access key; this is not the model key. Leaving it empty prints a security warning for a non-loopback host but does not block startup. |
| `server.allowedOrigins` | Four origins: `localhost` and `127.0.0.1`, each on ports 15173 and 17890 | CORS origin array. Explicit configuration replaces the default list and is used by the repository's own Web UI. |
| `model.baseUrl` | Empty | OpenAI-compatible API root address, for example `/v1`; must be configured together with `model.id`. |
| `model.id` | Empty | The sole business model ID. Image attachments require this model to support vision input; it is not automatically switched or downgraded. |
| `model.apiKey` | Empty | Model API key, written directly in the configuration file. |
| `model.contextWindow` | `32768` | Must be greater than `model.maxTokens`. |
| `model.maxTokens` | `4096` | Maximum model output. |
| `runtime.runTimeoutMs` | `120000` | Execution budget for one chat turn, in milliseconds. Timing pauses while manual approval is pending and resumes with the remaining budget after all pending approvals finish; it does not receive a fresh full budget. Approvals still expire according to their own TTL, and Stop/disconnection still cancels immediately. This does not change jobs-trigger timeout semantics. |
| `runtime.schedulerIntervalMs` | `30000` | Scheduled-task scan interval. |
| `runtime.monitorScanIntervalMs` | `60000` | Webpage-monitor scan interval. |
| `runtime.dataDir` | Directory containing the configuration file | Relative paths are resolved against the configuration file's directory. An absolute path is recommended but not required. |
| `tools.writable.enabled` | `true` | Whether to register `write` / `edit` and allow `skills.save`; when enabled, every operation still requires individual manual approval. `skills.list/read` remains available when this is disabled. |
| `tools.writable.actionTimeoutMs` | `300000` | Validity period for file-operation approval, in milliseconds; an expired approval cannot commit a modification. |
| `tools.web.enabled` | `true` | Whether to declare `search_web` / `web_fetch` to the model. |
| `tools.web.timeoutMs` | `30000` | Total timeout budget for one web fetch, in milliseconds. It includes up to 6 redirects, with each hop consuming the remaining time. |
| `tools.web.maxResponseBytes` | `2000000` | Maximum size of one response. |
| `tools.web.maxContentChars` | `50000` | Default maximum number of characters returned by `web_fetch`. |
| `tools.web.searchResults` | `5` | Default number of search results; the tool parameter allows at most 10. |
| `tools.web.userAgent` | Browser user agent | User-Agent for web requests. |
| `tools.web.allowPrivateTargets` | `false` | Explicitly relaxes the private-network/loopback target restriction only for local integration work; all other request security boundaries remain unchanged. |
| `tools.weather.enabled` | `true` | Whether to declare `get_weather` to the model. |
| `tools.weather.defaultCity` | Empty | Default city used when the user does not specify one. When empty, the model asks for the city. |
| `tools.browser.enabled` | `true` | Whether to enable the real-browser domain and the `navigate` / `snapshot` / `act` / `tab` tools. |
| `tools.browser.executablePath` | Empty | Path to the system Chrome executable. When omitted, Playwright's `chrome` channel is used. |
| `tools.browser.allowPrivateTargets` | `false` | Allows loopback and private-network pages only for local integration/testing; the default keeps the public HTTP(S) boundary. |
| `tools.browser.timeoutMs` | `30000` | Timeout for tab navigation and element operations. |
| `tools.presentation.default` | `hidden` | Tool presentation policy for the client's live stream and history projection: `hidden` hides tool calls, while `summary` sends only a controlled summary. |
| `tools.presentation.overrides` | `{}` | Overrides the default policy by tool name. Names follow the explicit registry in `src/adapters/pi/tools/index.ts`: `currentTime`, `instructions`, `memory`, `memory_search`, `schedule`, `subagent`, `goal`, `monitor`, `read`, `grep`, `find`, `ls`, `write`, `edit`, `skills`, `search_web`, `web_fetch`, `get_weather`, `navigate`, `snapshot`, `act`, and `tab`. |

By default, the `.pi-muse/` directory containing `.pi-muse/config.json` is also the instance data directory. The current default instance directory is unified as `.pi-muse/`; legacy directories are neither read nor migrated automatically. In other words, sessions, memory, jobs, the workspace, and the configuration file stay in the same instance directory.

`runtime.dataDir: "."` also denotes the configuration file's directory, regardless of the starting process's cwd. If `".pi-muse"` is placed inside `.pi-muse/config.json`, it points to a nested `.pi-muse/` beneath it, not the identically named directory at the project root.

Sessions are stored under `sessions/<threadId>/`; each thread has an independent pi session. A single user can have multiple threads. Internal subagent `subagent-<uuid>` workspaces and legacy worker `task-*` directories are not shown in the user conversation list. Each thread's working directory is fixed at `workspace/threads/<threadId>/`, and the shared area is `workspace/shared/`; see [Instance directory structure](#instance-directory-structure) below for the complete tree. There is no configurable global workspace fallback, and legacy root files or old cwd history are not migrated or cleaned automatically.

## Instance Directory Structure {#instance-directory-structure}

```text
.pi-muse/
├── config.json                         # startup configuration and credentials
├── auth.key                            # token signing key
├── profile/                            # global user profile, assistant persona, and memory configuration
│   ├── SOUL.md                         # free-form assistant persona
│   ├── USER.md                         # free-form user profile
│   ├── DREAM.md                        # global Dream consolidation prompt
│   └── memory.json                     # long-term memory and identity settings (retrieved on demand)
├── jobs.json / goals.json / actions.json / monitors.json
├── sessions/<threadId>/
│   ├── *.jsonl                          # authoritative pi history
│   ├── INSTRUCTIONS.md                  # conversation-specific instructions (including ## Space purpose), present as needed
│   ├── DREAM.md                         # supplemental Dream prompt for this conversation, present as needed
│   ├── dream.json                       # conversation Dream switch, cursor, latest result, and pending items, present as needed
│   └── skills.json                      # conversation skill overrides, present as needed
├── workspace/
│   ├── shared/                          # accessed explicitly with shared/...
│   └── threads/<threadId>/              # each conversation's private file area
├── skills/<name>/                         # optional instance skill; config is system-maintained
│   ├── SKILL.md                           # skill definition
│   ├── config.json                        # defaultEnabled; false for newly saved skills
│   ├── references/                        # optional supported text references
│   └── assets/                            # optional supported text assets
├── subagents/<role>.md                  # optional instance role override
└── agent/                               # pi runtime resources
```

Built-in skills and subagent roles are stored in the repository at `assets/skills/` and `assets/subagents/`, then copied to `dist/assets/` during the build; they are not placed in the instance directory. An identically named skill or role in the instance can override the built-in definition, but it cannot bypass existing permissions. The built-in `skill-creator` skill is enabled by default and provides the product skill-maintenance tool.

## Data Storage and Security Boundaries {#data-storage-and-security-boundaries}

- **Data is stored in plaintext**: conversation history, user profile, memory, workspace, and state files are all plaintext. The instance directory, `auth.key` (the signing key), and every instance backup contain sensitive credentials and personal data. Protect their permissions strictly as sensitive data (`0700`/`0600` is recommended), and never expose or upload them.
- **Access credential validity**: login Tokens are long-lived and survive service restarts. After `server.accessKey` changes and the service restarts with the new configuration, all old Tokens become invalid.
- **Single-process ownership and failure handling**: one process exclusively owns one `DATA_DIR`. If a file is corrupted or its format is invalid, the service reports a clear error and never restores an empty state by silently deleting damaged data. Stop the service and restore offline from a valid backup.

## Renaming the Instance Directory {#rename-instance-directory}

The legacy `.personal-bot/` is not automatically used as a fallback. Migration must first stop the service and preserve a protected backup. Besides any absolute `runtime.dataDir` in the configuration, you must also update offline the `cwd` in pi JSONL conversation headers and the path prefixes of `parentSession` links pointing inside the instance. Merely moving the files causes `continueRecent` to skip old conversations. Message bodies and session IDs remain unchanged; file mtimes must be preserved so the recent-conversation selection does not change. `auth.key` and `accessKey` must remain unchanged to continue using the original token. Migration and rollback must be checked for the actual instance and cannot rely on stale execution records. `.pi-muse-backups/` contains credentials; keep directory permissions at `0700` and sensitive-file permissions at `0600`, and do not commit or upload it.

## File Write Approvals {#file-write-approvals}

- `write` / `edit` can operate only in the private `DATA_DIR/workspace/threads/<threadId>/` area and in `workspace/shared/` accessed explicitly through `shared/...`. The main conversation likewise uses `threads/local-main/`, not a parent directory. Both reading and writing reject absolute paths, `..`, and root/target/parent-directory symlinks; `bash` is never exposed.
- Every operation requires separate manual approval. The approval payload retains the complete before/after text and file version; the text to replace for `edit` must match exactly one location.
- Path safety and file version are checked again before commit. If the file changes while waiting, the old approval cannot authorize an overwrite; the operation and approval must be initiated again.
- Rejection, approval expiration, or cancellation of the run prevents that modification from being committed. A service restart cancels pending approvals left by the previous process. Approval validity is fixed by the `expiresAt` recorded when it is created, and expiry and cancellation state are checked again before commit.
- The `skills` tool takes `action=list|read|save`, `name`, optional `file` (default `SKILL.md`), and the complete `content` required by save. A name may contain only lowercase letters, digits, or single hyphens and is limited to 64 characters. Allowed files are `SKILL.md` and supported UTF-8 text under `references/` or `assets/` with `.md`, `.txt`, `.json`, `.csv`, `.yaml`, or `.yml` extensions; each file is limited to 100KB.
- Use `skills.save` only for an explicit user request. It writes only `DATA_DIR/skills/<name>`; saving a built-in name creates an instance override and never changes the built-in file. A resource can be saved only after a valid instance `SKILL.md` exists. Its approval preview uses `scope=skill`, `ownerSpaceId=null`, and path `<name>/<file>`, with the same version binding and pre-commit path, cancellation, expiry, and file-change checks.
- A new skill's `config.json` is exactly `{ "defaultEnabled": false }`; neither the global catalog nor the current space is enabled implicitly. After you enable it for a space, its new definition, references, and assets take effect on the next model turn—the current turn does not gain new instructions or extension capabilities. Rejection, expiry, Stop, or a file change while waiting writes nothing, and an unknown result is never resent automatically.
- Skill maintenance refuses deletion, directory operations, direct `config.json` edits, scripts/code, binaries, nested `SKILL.md`, absolute paths, traversal, and symlinks. For an enabled skill, ordinary `read` additionally exposes only its `SKILL.md` and supported resource text—not ls/grep/find or neighboring files. Subagents do not receive `skills`.
- Disabling `tools.writable.enabled` removes `write` / `edit` and refuses `skills.save` in a controlled way while retaining `skills.list/read`. Tool presentation policy cannot skip approval or enable write capability that has been disabled.

To create and use a skill in the mobile client:

1. Tell the assistant which skill to create or revise in chat, for example, "Create a Linux news filtering skill that prioritizes kernel and distribution updates."
2. Tap the avatar at the top to open the session panel, then open approvals. Review the target file and complete before/after content under "技能库" (skill library). Approve only if it matches your intent, then wait for the "文件写入成功" (file written successfully) execution receipt.
3. In the same panel, open the workspace, find the skill, turn it on, and save the space's skills. New skills are off by default and must be enabled separately in each space where you want to use them.
4. Send the next message to use the skill. Revisions to an enabled skill also load on the next turn; approving a save does not itself enable the skill.

## Tool Presentation Policy {#tool-presentation-policy}

Presentation configuration affects the live stream and history projection consumed by the repository's own Web UI. It does not disable tools, change the complete result received by the model, or rewrite pi JSONL. Restart the service after changing the configuration for it to take effect; existing history is re-projected according to the current policy, with no second history store or online migration. File-operation approval is an independent security process and is not skipped merely because a tool card is hidden.

- `hidden`: the live stream does not send that tool's complete `TOOL_CALL_*` group, and history does not return that call or its corresponding tool result. Only ordinary user/assistant text remains.
- `summary`: displays an existing card using the original tool name and stable ID. Parameters are uniformly `{}`, and the result uses a controlled summary. For example, saving memory shows only “Memory saved”（“已保存记忆”） rather than the memory text; reading a file only confirms completion without displaying its content.
- Search summaries retain the source URL/title but remove the snippet and provider diagnostics, as well as the URL query/fragment. A source link that depends on query parameters may therefore not open directly; when the original link is needed, the final reply should provide it. Search failure uses a valid `{error}` and is never misrepresented as “found 0 sources”.
- The example configuration explicitly enables summaries for time, weather, search, memory, and reminders. **When the entire presentation section is omitted, all tools are hidden by default.** Unknown tool names or invalid modes cause startup to fail. Policies can be preconfigured for disabled Web/weather tools, but presentation configuration cannot enable those capabilities.
- This is a presentation choice, not an information-confidentiality boundary: the model can still reference raw results in its final answer, and ordinary assistant text before a call, such as “Let me check,” continues to stream. `summary` still has a card and is not completely silent.

If you want chat to display only assistant text, add this inside the existing `tools` section:

~~~json
"presentation": {
  "default": "hidden",
  "overrides": {}
}
~~~

## Real Browser {#real-browser}

The browser domain uses `playwright-core` to drive the local system Chrome. It does not download a browser and always starts a real GUI window; headless mode is not provided. Chrome starts lazily, and its profile is fixed at `DATA_DIR/browser/profile/`. The server debug page `/browser` and the Agent's `navigate` / `snapshot` / `act` / `tab` tools share the same instance and persistent login state. When the service closes, WS subscriptions end and Chrome shuts down gracefully. Docker deployment uses Xvfb/X11, x11vnc, websockify, and noVNC to provide a complete real window rather than falling back to headless; see [the browser Docker guide](browser-docker.md).

`/browser` does not hard-code a service address. It calls REST APIs relative to the current access address and connects to the frame stream with a same-origin `ws://` or `wss://`. Therefore, local addresses, LAN IPs, domains, and reverse-proxy addresses all work directly. The URL can use `?accessKey=<workspace-access-key>` or `?key=<workspace-access-key>` for direct automatic login. An HTTPS reverse proxy must also forward `/ws/browser` and preserve Upgrade headers.

Only public HTTP(S) is allowed by default; explicitly set `tools.browser.allowPrivateTargets: true` when local test pages must be accessed. This address rule is only a base implementation shared with the web tools—the browser domain does not depend on `web_fetch`. The browser does not expose arbitrary JavaScript evaluation to the model and does not return cookies, localStorage, or password values. External page titles, text, and element names are treated as untrusted data.

## Error Policy {#error-policy}

- The configuration file is required; if it does not exist, there is no environment-variable fallback.
- JSON syntax errors, unknown fields, invalid types, or an unknown `schemaVersion` cause startup to fail.
- `model.baseUrl` and `model.id` must both be empty or both configured.
- `model.baseUrl` accepts only credential-free HTTP(S) URLs without a query or fragment.
- A non-loopback `server.host` should be paired with `server.accessKey`. The current default behavior is only a warning—not a block—when the host is `0.0.0.0` and accessKey is empty.
- The service never creates or rewrites the configuration file automatically, preventing startup paths from unexpectedly overwriting a hand-written configuration.
- Web requests allow only public HTTP(S) by default and block loopback, private, link-local, and reserved addresses; every redirect is validated again. For local integration, explicitly set `tools.web.allowPrivateTargets: true`; this does not change the other request security constraints.

## Keys and File Permissions {#keys-and-file-permissions}

`config.json` may contain both a model key and the workspace access key:

- Do not commit it to Git; `.pi-muse/` is already in gitignore.
- Do not screenshot it or paste its full contents into chat.
- Keep permissions at `0600` where possible.
- The server does not write keys to logs, return them to clients, or write them into pi session files.
- Protect configuration-file backups with the same safeguards as sensitive credentials.

## Mock Configuration {#mock-configuration}

`pnpm dev:mock` does not read `.pi-muse/config.json` and does not call a real model. It explicitly constructs an isolated configuration in `scripts/dev-mock.ts`:

- Listens on `127.0.0.1:17891`
- Uses a fake provider
- Uses `.pi-muse/mock` as its data directory

The mock port and directory do not offer environment-variable overrides. If they must be changed, modify the explicit configuration object in the script directly.
