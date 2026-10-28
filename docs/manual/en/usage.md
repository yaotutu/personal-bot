# Core Capabilities

## Conversations and Spaces {#conversations-and-spaces}

After connecting the mobile client to the server, you can create and switch between spaces. Each space has its own conversation and instructions. Chat supports streaming replies, tool execution status, and history; the client sends file attachments and images, while image understanding depends on the configured model's capabilities.

## Tasks, Goals, and Memory {#tasks-goals-and-memory}

You can request one-off or daily scheduled tasks, webpage monitors, and long-term goals in a conversation, then view and manage them in the corresponding client pages. Webpage monitors work with public HTTP(S) pages. Long-term memory is retrieved on demand; the optional periodic Dream consolidation must be enabled separately. Failed tasks display an error and do not automatically rerun the model or tools.

## Files and Approvals {#files-and-approvals}

The ordinary file tools can access only the current conversation's private workspace and the explicitly designated `shared/...` shared area. Every model-initiated `write` or `edit` requires a person to review the complete modification preview and approve it; rejection, expiration, a file change, or cancellation of the run prevents that modification from being committed. The server does not provide `bash` to the model.

## Browser {#browser}

The server provides a real graphical browser capability, with enabling and access scope controlled by configuration. For Docker and noVNC deployment and manual takeover steps, see [the browser guide](browser-docker.md); the exact browser integration available inside the mobile client is defined by its corresponding release version.

## Data and Network {#data-and-network}

The server's instance directory stores plaintext conversations, memory, and credentials, so protect the permissions of the directory and its backups. Model requests send the content required by the current task to the configured external model service. HTTP can be used to connect, but it does not encrypt the AccessKey, Token, or conversation content; assess the network environment before remote access. For more settings, see [Configuration](configuration.md).
