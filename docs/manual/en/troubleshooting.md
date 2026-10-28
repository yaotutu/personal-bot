# FAQ

## The Phone Cannot Connect to the Server {#phone-cannot-connect-to-server}

Confirm that the server process is running, the port is reachable, and the client uses the server's base address without `/api` or `/docs`. On a physical phone, `localhost` refers to the phone itself; for a LAN connection, enter the computer's LAN address. First visit `/api/health` on the server machine, then check the network path and firewall from the phone to the server.

## AccessKey Rejected {#access-key-rejected}

The client must use `server.accessKey`, not `model.apiKey`. Check the configuration actually read by the current server and the value that took effect after a restart. Changing the AccessKey invalidates old Tokens, so the client must reconnect. Never paste any key into public logs or issue reports.

## No Model Reply {#no-model-reply}

Check that `model.baseUrl`, `model.id`, and `model.apiKey` all point to the same usable model service, then review the server's controlled error message. After a model service error, there is no automatic retry; if the previous turn performed a write or another operation, first verify its actual result before deciding whether to send the request again.

## File Modification Did Not Take Effect {#file-modification-did-not-take-effect}

`write` and `edit` each require separate manual approval. Check the complete modification preview and approval status in the client. Rejection, expiration, a file change while waiting, or cancellation of the run prevents that commit. If the result is unknown, first read the target file to confirm its current state rather than automatically resending the write operation.

For configuration fields and permission boundaries, see [Configuration](configuration.md). For development and API troubleshooting entry points, see [Development](development.md).
