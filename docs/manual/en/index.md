# Pi Muse Manual

This manual corresponds to the current repository source and introduces how to install, connect, use, and secure the Pi Muse server and its standalone mobile client. The actual capabilities of released Android versions are defined by the [mobile client Releases](https://github.com/yaotutu/pi-muse-mobile/releases) and their release notes; nothing here implies that a new APK has already been published.

## Where to Start {#where-to-start}

- [Quick Start](getting-started.md): install the server, prepare its configuration, and connect the mobile client.
- [Core Capabilities](usage.md): learn about spaces, conversations, tasks, goals, memory, and approval entry points.
- [Configuration](configuration.md): look up server configuration fields and the data directory.
- [Browser Docker and noVNC](browser-docker.md): deploy a graphical browser when needed.
- [Development](development.md): local documentation site, business development, and API documentation entry points.
- [FAQ](troubleshooting.md): diagnose connections, AccessKeys, models, and approvals.

The repository's `web/` directory is used for HTTP/SSE integration testing and verification; the primary product client is a separate mobile app. For API integration, use the running server's `/docs` and `/openapi.json` as the authoritative references.
