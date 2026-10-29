# Core Capabilities

This page keeps only capability entry points. Detailed procedures live in their dedicated guides so the same workflow is not maintained twice.

## Conversations and Spaces {#conversations-and-spaces}

The mobile client supports streaming chat, execution status, the space sidebar, the session panel, stopping runs, resetting sessions, and deleting spaces. Each space has an independent conversation, private workspace, space rules, and skill switches. See [Conversations and spaces](conversations-and-spaces.md).

## Attachments, Files, and Approvals {#files-and-approvals}

Message attachments enter model context with chat history; workspace files are persistent server files; every model-initiated `write` or `edit` requires separate human approval. For their entry points, limits, and dangerous operations, see [Attachments, files, and approvals](files-and-approvals.md).

## Tasks, Goals, and Memory {#tasks-goals-and-memory}

- [Tasks and webpage monitors](tasks-and-monitors.md): scheduled execution, webpage change checks, management actions, and activity records.
- [Goals and milestones](goals.md): status and progress tracking for long-term goals, not scheduled task execution.
- [Memory and Dream](memory-and-dream.md): long-term memory search and management, plus separately configured consolidation.

## Profile and Settings {#profile-and-settings}

For editing assistant identity, persona, and user profile, as well as themes, connection maintenance, browser access, and Android app updates, see [Profile and settings](profile-and-settings.md).

## Browser {#browser}

The server provides a real graphical browser capability, with enabling and access scope controlled by configuration. For Docker and noVNC deployment, see [the browser guide](browser-docker.md). The mobile app opens the configured noVNC address in the system browser; see [Profile and settings](profile-and-settings.md) for the entry point.

## Data and Network {#data-and-network}

The server instance directory stores plaintext conversations, memory, and credentials, so protect the directory and backups. Model requests send the content required by the current task to the configured external model service. HTTP can be used to connect, but it does not encrypt the AccessKey, Token, or conversation content. For more settings, see [Configuration](configuration.md).
