# Pi Muse Manual

This manual introduces installation, connection, daily use, and security boundaries for the Pi Muse server and standalone mobile client. It is checked against the current repository source; current source does not automatically equal a released APK. For Android capabilities, use the [mobile client Releases](https://github.com/yaotutu/pi-muse-mobile/releases) and the corresponding release notes.

## Where to Start {#where-to-start}

- [Quick Start](getting-started.md): install the server, connect the phone, send a message, and receive a reply.
- [Conversations and spaces](conversations-and-spaces.md): send and stop conversations, switch spaces, reset sessions, and delete spaces.
- [Attachments, files, and approvals](files-and-approvals.md): distinguish message attachments, workspace files, and model file-write approvals.
- [Core Capabilities](usage.md): overview of tasks, goals, memory, browser, and data boundaries.
- [Configuration](configuration.md): look up server configuration fields and the data directory.
- [Browser Docker and noVNC](browser-docker.md): deploy a graphical browser when needed.
- [Development](development.md): local documentation site, business development, and API documentation entry points.
- [FAQ](troubleshooting.md): diagnose connections, AccessKeys, models, attachments, and approvals.

The repository's `web/` directory is used for HTTP/SSE integration testing; the primary product client is a separate mobile app. For API integration, use the running server's `/docs` and `/openapi.json` as the authoritative references.
