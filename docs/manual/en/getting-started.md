# Quick Start Guide

This guide explains how to configure and start the Pi Muse server from scratch, connect the Android mobile client, send a message, and receive a reply. For the authoritative description of every configuration field, see [Configuration](configuration.md). For daily spaces, attachments, workspace files, and approvals, see [Conversations and spaces](conversations-and-spaces.md) and [Attachments, files, and approvals](files-and-approvals.md).

This manual was checked against the current repository source; source capabilities do not automatically equal those of a released APK in [pi-muse-mobile Releases](https://github.com/yaotutu/pi-muse-mobile/releases). When using a release build, follow its actual UI and release notes.

## Prerequisites {#prerequisites}

- **Node.js**: `>= 24`
- **pnpm**: `12.10.1`
- **Large model service**: any API compatible with the OpenAI Chat Completions protocol, with a usable `baseUrl`, model `id`, and provider `apiKey`. If you want the model to understand images, the configured model must itself support image input.
- **Mobile client**: Android is the priority platform. The mobile steps in this manual were verified by source inspection, not as a test of a released APK.

## Install and Configure {#install-and-configure}

1. On the host that will run the server, clone the repository and install dependencies:

   ```sh
   git clone https://github.com/yaotutu/pi-muse.git
   cd pi-muse
   pnpm install
   ```

2. Initialize the configuration file. If `.pi-muse/config.json` already exists, edit it directly instead of overwriting it:

   ```sh
   mkdir -p .pi-muse
   cp -n config.example.json .pi-muse/config.json
   chmod 600 .pi-muse/config.json
   ```

3. Edit `.pi-muse/config.json` and replace the example server address, model, and keys with your own. Use a sufficiently long random value for `server.accessKey`; do not reuse the example:

   ```json
   {
     "schemaVersion": 1,
     "server": {
       "host": "0.0.0.0",
       "port": 12330,
       "accessKey": "your-secure-access-key"
     },
     "model": {
       "baseUrl": "https://your-provider.example/v1",
       "id": "your-model-id",
       "apiKey": "your-model-api-key"
     }
   }
   ```

### Important Configuration Distinctions {#important-configuration-distinctions}

- **Never confuse `model.apiKey` with `server.accessKey`**:
  - `model.apiKey` is the API credential for the external large model provider and is used only by the server.
  - `server.accessKey` is the Pi Muse server access key. The mobile client and Web workspace exchange it for a session Token.
- **`model.baseUrl`** is the API root address, such as `https://api.openai.com/v1`; do not append the complete `/chat/completions` path.
- **`server.host`** defaults to `0.0.0.0` and listens on every network interface for convenient LAN access. Set `127.0.0.1` for same-computer access only.
- For tool and runtime fields, see [Configuration](configuration.md).

## Start the Service {#start-service}

Development debug mode:

```sh
pnpm dev
```

This runs the source in watch mode and listens on port `12330` on every interface by default. From the server machine, visit `http://127.0.0.1:12330`.

Production build and run:

```sh
pnpm build
pnpm start
```

`pnpm start` runs the compiled API service and does not automatically host the developer Web workspace. For that workspace, see [Development](development.md).

The server also handles periodic reminder scanning, Dream memory consolidation, and webpage monitoring. Deploy it on an always-on host and use a process manager such as tmux, pm2, or systemd as appropriate.

Restarting the service does not rerun expired one-off reminders, and failed jobs do not automatically call the model or tools again. If a chat stream disconnects, its run is canceled, but tool operations that already completed are not rolled back.

## Connect the Mobile Client {#connect-mobile-client}

1. Download and install the Android APK matching your device architecture from [pi-muse-mobile Releases](https://github.com/yaotutu/pi-muse-mobile/releases). Check that release's notes first; do not assume every capability in current server source is already in the APK.
   iOS users may download `app-release-unsigned.ipa` only when that asset is actually present in the selected release, then re-sign it using their own valid certificate and provisioning profile. An unsigned IPA cannot be installed directly. This is not App Store or TestFlight distribution and does not use the Android in-app updater.
2. Confirm the phone can reach the server:
   - The phone may connect directly over HTTP to a LAN or remote server. A domain, certificate, or HTTPS reverse proxy is not required.
   - Do not enter `localhost` or `127.0.0.1` on the phone. `localhost` refers to the phone itself, not the computer running the server.
   - On a LAN, enter the computer's actual address, such as `http://192.168.1.100:12330`, and allow inbound port `12330` through the computer firewall.
3. Open Pi Muse, go to the bottom「设置」tab, and tap「服务器连接」（Server Connection）under「连接与设备」.
4. On the「服务器连接」page, enter:
   - 「服务器地址」: the server base address, without `/api`, `/docs`, or a trailing path slash.
   - 「访问密钥」: the `server.accessKey` from the configuration file, not `model.apiKey`.
5. Tap「保存」(Save). The app verifies the current address and access key before saving; failure leaves the previous configuration unchanged. On success, the panel closes and the connection status shows「已连接」.
6. Optionally tap「测试连接」first. A successful test shows「连接正常」and「保存后生效」; testing does not save the configuration.

While testing or verifying before a save, close the panel to cancel without saving the draft. A test can also be canceled with「取消测试」. Actual configuration writes or local cache cleanup must finish before closing. If you change to a different server address, the client first asks you to confirm clearing local business cache and old credentials; that action does not delete data on the remote server.

## Send a Message and Receive a Reply {#send-first-real-reply}

1. Return to the bottom「聊天」tab. A new installation shows「主空间」and「有什么想聊的？」.
2. In the input field with the「消息」placeholder, enter a short, verifiable request, such as a question whose answer you already know.
3. Tap the send arrow on the right of the input field. Your message bubble appears and the right-hand button becomes a stop square. Tap the avatar to view detailed execution status in the session panel.
4. Wait for the assistant reply. A real reply streams into the chat page; if the model calls tools, their status appears in tool cards or the session panel's activity view.

If the chat page reports that the model is not configured, the connection is offline, or reauthentication is required, diagnose it with the [FAQ](troubleshooting.md) instead of repeatedly resending the same message. For attachments, see [Attachments, files, and approvals](files-and-approvals.md#send-attachments). For stopping a run, resynchronizing, and unknown-result handling, see [Conversations and spaces](conversations-and-spaces.md#send-and-stop-conversations).

## Network Security Boundaries {#network-security-boundaries}

- **LAN access**: when `server.host` is `0.0.0.0`, set a strong random `server.accessKey` to prevent unauthorized devices on the same LAN from making calls.
- **HTTP and remote access**: HTTP connections work, but the AccessKey, Token, and chat content are not encrypted in transit. Prefer trusted networks; HTTPS or secure virtual networking is optional protection, not a startup or connection prerequisite.
- **Instance data protection**: `.pi-muse/` contains the model API key, server access key, token signing key, and plaintext conversations and memory. Do not expose or upload the directory.

## Verify the Service {#verify-service}

After the service starts, check these endpoints from the server machine:

- **Health check**: `http://127.0.0.1:12330/api/health`, which returns service status and whether model configuration is ready.
- **API documentation**: `http://127.0.0.1:12330/docs`, generated by the running instance.
- **OpenAPI specification**: `http://127.0.0.1:12330/openapi.json`.

A passing health check does not mean model requests work. Send a message from the phone and receive a reply from the external model to confirm that installation, connection, and model configuration work together.
