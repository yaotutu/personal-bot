# syntax=docker/dockerfile:1
# Google Chrome 目前只发布 linux/amd64；Apple Silicon 需要通过 Docker 的 amd64 模拟运行。
FROM --platform=linux/amd64 node:24-bookworm-slim

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg tini util-linux \
      xvfb x11vnc fluxbox novnc websockify \
      fonts-liberation fonts-noto-cjk fonts-noto-color-emoji; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg; \
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends google-chrome-stable; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.10.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production

RUN groupadd --gid 10001 pimuse \
    && useradd --uid 10001 --gid pimuse --create-home --shell /usr/sbin/nologin pimuse \
    && mkdir -p /app/.pi-muse \
    && chown -R pimuse:pimuse /app/.pi-muse

USER root
EXPOSE 17890 6080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:17890/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

COPY scripts/container-browser-entrypoint.sh /usr/local/bin/container-browser-entrypoint
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/container-browser-entrypoint"]
