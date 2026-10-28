# Quick Start Guide

This guide explains how to configure and start the Pi Muse server from scratch, then connect it to the mobile client. For the complete and authoritative description of configuration fields, see [Configuration](configuration.md).

## Prerequisites {#prerequisites}

- **Node.js**: `>= 24`
- **pnpm**: `12.10.1`
- **Large model service**: any API compatible with the OpenAI Chat Completions protocol. It must provide a `baseUrl` and model `id`, plus the provider's corresponding `apiKey`.

## 1. Install and Configure {#install-and-configure}

Clone the repository and install dependencies:

```sh
git clone https://github.com/yaotutu/pi-muse.git
cd pi-muse
pnpm install
```

Initialize the configuration file. If it already exists, edit it directly instead of overwriting it:

```sh
mkdir -p .pi-muse
cp -n config.example.json .pi-muse/config.json
chmod 600 .pi-muse/config.json
```

Edit `.pi-muse/config.json` and replace the API address, model name, and keys below with your own values. Use a sufficiently long random value for the server access key rather than reusing the example:

```json
{
  "schemaVersion": 1,
  "server": {
    "host": "0.0.0.0",
    "port": 17890,
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
  - `model.apiKey` is the API credential for calling the external large model provider. The server uses it when making model requests.
  - `server.accessKey` is the access key for the Pi Muse server. The mobile client and Web workspace use it for authenticated login. Always set it for LAN or public-network deployment.
- **`model.baseUrl`**: enter the API root address, such as `https://api.openai.com/v1`; do not enter the full `/chat/completions` path.
- **`server.host`**: defaults to `0.0.0.0`, which accepts connections on every network interface and makes LAN access from the phone convenient. If you only access the service from the same computer through a web page or command line, set it to `127.0.0.1`.
- For more tool and runtime fields, see [Configuration](configuration.md).

## 2. Start the Service {#start-service}

### Development Debug Mode {#development-debug-mode}

```sh
pnpm dev
```

This command runs from source in watch mode with hot reloading. By default it listens on port `17890` on every interface; from the server machine, visit `http://127.0.0.1:17890`.

### Production Build and Run {#production-build-and-run}

```sh
pnpm build
pnpm start
```

> **Note**: `pnpm start` runs the compiled API service and **does not automatically host static frontend pages**. To use the developer Web workspace, see [Development](development.md).

### Keeping the Service Online {#keep-service-online}

The Pi Muse server handles periodic responsibilities including scheduled reminder scanning, long-term memory consolidation (Dream reflection jobs), and webpage monitoring. To ensure reminders trigger on time and clients stay connected, deploy the server on an always-on host or server, using tools such as tmux, pm2, or systemd for background management.

Restarting the service does not rerun expired one-off reminders, and failed jobs do not automatically call the model or tools again. If a conversation stream disconnects, its run is canceled, but operations that already completed are not rolled back.

## 3. Connect the Mobile Client {#connect-mobile-client}

Pi Muse primarily uses a standalone mobile client, with Android currently prioritized.

1. **Download and install**: go to [pi-muse-mobile Releases](https://github.com/yaotutu/pi-muse-mobile/releases) and download the latest Android package (APK).
2. **Confirm network connectivity**:
   - The phone can connect directly over HTTP to a LAN or remote server. A domain name, certificate, or HTTPS reverse proxy is not required. Secure virtual networking and HTTPS are optional.
   - **Do not enter `localhost` or `127.0.0.1` on the phone**: `localhost` on the phone refers to the phone itself and cannot reach a service running on the computer.
   - On a LAN, find the computer's actual LAN IP address (for example, `http://192.168.1.100:17890`) and check the computer's firewall to allow inbound connections on port `17890`.
3. **Sign in from the client**:
   - Enter a reachable HTTP base address, such as `http://192.168.1.100:17890` or `http://your-server.example:17890`. Do not append `/api` or `/docs`.
   - Enter the `server.accessKey` from the configuration file as the access key.
   - Tap “Test Connection”（「测试连接」）; after it succeeds, tap “Connect Server”（「连接服务器」） to save. A successful test alone does not save the configuration.

## 4. Network Security Boundaries {#network-security-boundaries}

- **LAN access**: when `server.host` is `0.0.0.0`, set a strong random `server.accessKey` to prevent unauthorized devices on the same LAN from making calls.
- **HTTP and remote access**: HTTP is fully supported and the server port must be reachable by the phone. However, the access key, Token, and chat content are not encrypted in transit, so an AccessKey is not a substitute for encryption. Prefer trusted networks; HTTPS or secure virtual networking is optional protection, not a prerequisite for starting or connecting.
- **Instance data protection**: the `.pi-muse/` instance directory contains the model API key, server access key, token signing key, and all plaintext conversations and memory. Never expose or upload it.

## 5. Verify the Service {#verify-service}

After the service starts, use these endpoints to verify its status:

- **Health check**: `http://127.0.0.1:17890/api/health` (returns service status and whether model configuration is ready)
- **API documentation**: `http://127.0.0.1:17890/docs` (interactive Scalar API documentation)
- **OpenAPI specification**: `http://127.0.0.1:17890/openapi.json`

For local interactive integration without real model credentials, see [Local Business Development](development.md#local-business-development); mock mode uses a fake provider and cannot replace acceptance testing against the real backend and external model.
