<div align="center">

<img src="docs/assets/muse.png" width="112" alt="Pi Muse">

# Pi Muse

[English](README.md) | [简体中文](README.zh-CN.md)

**A client-first, open-source personal agent built on [pi](https://github.com/earendil-works/pi)**

Self-host your personal agent and connect across Android, iOS, terminals, and other platforms through its public HTTP/SSE API. A dedicated mobile client keeps conversations, tasks, goals, and approvals within reach.

**[Download Android APK](https://github.com/yaotutu/pi-muse-mobile/releases/latest/download/app-release.apk)** · [Client Repository](https://github.com/yaotutu/pi-muse-mobile) · [Release Notes](https://github.com/yaotutu/pi-muse-mobile/releases/latest)

Deploy the server, install the app, then enter your server address and AccessKey to connect. No client rebuild is needed for your deployment. Prebuilt app downloads currently target Android; other platforms can integrate through the documented API.

[Quick Start](#quick-start) · [Core Features](#core-features) · [Why Client-First](#why-client-first) · [Architecture](#architecture-and-communication-protocol) · [Android Download](https://github.com/yaotutu/pi-muse-mobile/releases)

[![GitHub stars](https://img.shields.io/github/stars/yaotutu/pi-muse?style=flat-square&logo=github)](https://github.com/yaotutu/pi-muse/stargazers)
[![Node](https://img.shields.io/badge/Node.js-24%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)

<br/>

<p align="center">
  <img src="docs/assets/showcase.png" width="98%" alt="Pi Muse Showcase">
</p>

</div>

---

## Why Client-First?

Many personal-agent projects live inside an existing chat platform or a basic web chat window. For an assistant that handles ongoing personal work, that layout quickly becomes limiting:

1. **A chat log is not a control room.** Conversation streams are good for immediate exchanges, but poor for managing recurring jobs, reviewing sub-agent progress, or checking milestones in a long-term plan.
2. **Each capability has its own surface.** Pi Muse gives conversations, spaces, scheduled jobs, web monitors, goals, and approval workflows dedicated screens and action flows instead of burying them in scrollback.
3. **The client is treated as the product.** The mobile interface includes purposeful navigation, gesture support, an animated companion, and light and dark themes tuned for phone use.

---

## Core Features

### Chat and Isolated Spaces

<p align="center">
  <img src="docs/assets/chat-preview.png" width="88%" alt="Chat and space sidebar">
</p>

- **Streaming conversation and structured rendering.** Chat runs over AG-UI SSE and renders Markdown, copyable code blocks, nested lists, and inline tool-status cards in the client.
- **Isolated spaces.** Create contexts such as Work, Life, or Study. Each space has its own conversation tree, space instructions, and tool switches.
- **A navigable space sidebar.** Open it from the header menu or with an edge-swipe gesture, then search and switch between spaces.

---

### Scheduled Jobs and Web Monitors

<p align="center">
  <img src="docs/assets/tasks-preview.png" width="88%" alt="Scheduled jobs and web monitors">
</p>

- **Natural-language scheduling.** Ask for a one-time reminder at an explicit timestamp or a daily job at a fixed time. Schedules currently support one-time and daily jobs only.
- **Background web monitoring.** Provide a public page URL and a condition such as page-text changes or a keyword match. The server checks it in the background and notifies you when the condition is met.
- **Visible task state.** The Tasks screen shows upcoming run times, check counts, and recent errors, with controls to refresh, pause, stop, or delete individual items.

---

### Long-Term Goals and Milestones

<p align="center">
  <img src="docs/assets/goals-preview.png" width="52%" alt="Long-term goals and milestone tracking">
</p>

- **Break large goals into milestones.** Discuss a medium- or long-term objective with the agent and turn it into concrete checkpoints.
- **Check off progress interactively.** Mark milestones complete on the phone and see completion times and overall progress such as `1 / 3`.
- **Filter and sort views.** Switch between all, active, paused, completed, and archived goals, then sort by update or creation time.

---

### Session Center, Space Rules, and Human Approval

<p align="center">
  <img src="docs/assets/session-preview.png" width="88%" alt="Activity center and space-rule settings">
</p>

- **Activity center.** Open it from the chat screen to follow current agent activity, tool calls, and sub-agent collaboration. It shows activity events, not hidden model reasoning.
- **Explicit file-change approval.** The agent has no shell tool. File `write` and `edit` operations are restricted to the current workspace and require a full before/after diff approval for every operation; stale or changed-file approvals cannot be committed.
- **Per-space rules and tools.** Add instructions for the current space and enable or disable capabilities such as browser tools for that context.

---

### Real Browser with noVNC Takeover

- **A real graphical Chrome environment.** The Docker deployment runs a full Linux Chrome desktop rather than a headless browser.
- **Manual intervention when needed.** Open the noVNC view from a browser to handle visual challenges, complex logins, or interactions that require a human decision.

---

### Settings and Personal Profile

<p align="center">
  <img src="docs/assets/settings-preview.png" width="52%" alt="Settings and personal profile">
</p>

- **Connection management.** Configure a LAN or remote server address and authenticate with the server AccessKey. The client stores a session token, not the plaintext AccessKey.
- **Assistant and user profiles.** Customize the assistant's name and tone, and store useful personal preferences.
- **Long-term memory and Dream.** Search accumulated memory and let the optional Dream process periodically organize memories and propose follow-up items.

---

## Quick Start

### 1. Run the Server

Requirements:

- Node.js `>= 24`
- pnpm `12.10.1`
- An OpenAI-compatible model API

Clone the public repository and install dependencies:

```sh
git clone https://github.com/yaotutu/pi-muse.git
cd pi-muse
pnpm install
```

Create the required configuration file, restrict its permissions, then edit it before starting the server:

```sh
mkdir -p .pi-muse
cp -n config.example.json .pi-muse/config.json
chmod 600 .pi-muse/config.json
```

Set at least `server.accessKey`, `model.baseUrl`, `model.id`, and `model.apiKey` in `.pi-muse/config.json`. See [Configuration](docs/configuration.md) for every field.

Start the development server:

```sh
pnpm dev
```

The API listens on port `17890` by default. For a production build, use `pnpm build && pnpm start`.

#### Optional Browser Container

The browser container is an optional alternative deployment that also provides noVNC access:

```sh
docker compose -f compose.browser.yaml up --build -d
```

Its default API port is also `17890`, so it cannot run at the same time as the local server on the same host port. Run it instead of the local service or map different host ports. See [Browser Docker](docs/browser-docker.md).

---

### 2. Connect the Android Client

1. [Download the latest Android APK](https://github.com/yaotutu/pi-muse-mobile/releases/latest/download/app-release.apk). See the [client repository](https://github.com/yaotutu/pi-muse-mobile) for source and platform details, or [release notes](https://github.com/yaotutu/pi-muse-mobile/releases/latest) for the published version.
2. Install and open the app on an Android device or emulator.
3. Go to **Settings -> Server Connection**, enter a reachable server address such as `http://192.168.1.100:17890` or `http://your-server.example:17890`, and enter the configured `server.accessKey`.
4. Tap **Test Connection**, then **Connect to Server** to save the verified connection. A successful test alone does not save it.

HTTP is supported directly; a domain, certificate, and HTTPS reverse proxy are not required. Use the server's base address, without `/api` or `/docs`. On a physical phone, `localhost` and `127.0.0.1` refer to the phone, not your server. Keep the server running and its port reachable. Model credentials stay on the server: the app needs the server AccessKey, not the model API key. See [Getting Started](docs/getting-started.md#3-连接手机客户端) for network setup.

The repository's `web/` app is an HTTP/SSE development and verification page, not the primary product client.

---

### 3. Build for Another Platform

The public REST and SSE contracts are available at runtime from `/docs` and `/openapi.json`. Use them to build iOS, terminal, or other clients, or integrate Pi Muse into your existing tools.

---

## Architecture and Communication Protocol

Pi Muse uses HTTP for requests and management, plus one-way SSE streams for server-to-client events:

1. **Agent execution stream.** A chat request starts an AG-UI SSE response that carries tokens, tool events, and result updates from server to client.
2. **Workspace notification stream.** `/api/events` is a shared SSE stream for status updates, pending file approvals, and activity events.
3. **REST management.** Spaces, history reads, memory search, jobs, monitors, goals, approvals, and other controls use documented HTTP requests.

---

## Data and Privacy Security

- **Self-hosting is not offline.** The configured model provider receives the prompts and context needed for the current task. Other server data remains on your deployment, but model requests leave it.
- **Local data is plaintext.** Conversations, profiles, memory, workspace files, job state, signing keys, and configured credentials are stored locally without encryption at rest. Protect instance-directory and backup permissions.
- **Use an AccessKey and understand HTTP.** Set a strong `server.accessKey`. HTTP is supported, but sends login credentials, tokens, and conversation content without transport encryption. Prefer a trusted network; HTTPS or a secure private network is optional protection for remote access, not a connection requirement.
- **Least-privilege tools.** There is no shell tool. Web requests target public HTTP(S) by default with SSRF checks, and file writes are workspace-scoped and individually approved through full diffs.

---

## Documentation

The detailed documentation is currently written in Chinese.

- [Getting Started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Browser Docker](docs/browser-docker.md)
- [Development](docs/development.md)
- [HTTP API Contract](docs/http-api-contract.md)
- [Avatar Assets](docs/avatar.md)
- [Testing Guide](docs/testing.md)

---

## Acknowledgements

- [pi](https://github.com/earendil-works/pi): agent execution and session management
- [nanobot](https://github.com/HKUDS/nanobot): design reference for personal-assistant features
- Muse: interface and interaction design reference
