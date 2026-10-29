# Core Capabilities

This page keeps only capability entry points. Detailed procedures live in their dedicated guides so the same workflow is not maintained twice.

## Conversations and Spaces {#conversations-and-spaces}

The mobile client supports streaming chat, execution status, the space sidebar, the session panel, stopping runs, resetting sessions, and deleting spaces. Each space has an independent conversation, private workspace, space rules, and skill switches. See [Conversations and spaces](conversations-and-spaces.md).

## Attachments, Files, and Approvals {#files-and-approvals}

Message attachments enter model context with chat history; workspace files are persistent server files; every model-initiated `write` or `edit` requires separate human approval. For their entry points, limits, and dangerous operations, see [Attachments, files, and approvals](files-and-approvals.md).

## Tasks, Goals, and Memory {#tasks-goals-and-memory}

You can request one-off or daily tasks, webpage monitors, and long-term goals in a conversation, then manage them in the corresponding client pages. Webpage monitors work with public HTTP(S) pages. Long-term memory is retrieved on demand; periodic Dream consolidation must be enabled separately. Failed tasks display an error and do not automatically rerun the model or tools.

## Browser {#browser}

The server provides a real graphical browser capability, with enabling and access scope controlled by configuration. For Docker and noVNC deployment, see [the browser guide](browser-docker.md). Browser integration inside a mobile build is defined by that released version.

## Data and Network {#data-and-network}

The server instance directory stores plaintext conversations, memory, and credentials, so protect the directory and backups. Model requests send the content required by the current task to the configured external model service. HTTP can be used to connect, but it does not encrypt the AccessKey, Token, or conversation content. For more settings, see [Configuration](configuration.md).
