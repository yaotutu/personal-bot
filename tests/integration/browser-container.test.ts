import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
const read = (path: string) => readFile(join(root, path), "utf8");

test("browser container keeps Chrome headed and exposes its real GUI through noVNC", async () => {
  const dockerfile = await read("Dockerfile");
  const entrypoint = await read("scripts/container-browser-entrypoint.sh");
  const compose = await read("compose.browser.yaml");
  const dockerignore = await read(".dockerignore");

  assert.match(dockerfile, /google-chrome-stable/);
  assert.match(dockerfile, /\bxvfb\b/);
  assert.match(dockerfile, /\bx11vnc\b/);
  assert.match(dockerfile, /\bnovnc\b/);
  assert.match(dockerfile, /\bwebsockify\b/);
  assert.match(dockerfile, /USER root/);
  assert.doesNotMatch(entrypoint, /--headless/);
  assert.match(entrypoint, /install -d -m 1777 \/tmp\/\.X11-unix/);
  assert.match(entrypoint, /HOME=\/home\/pimuse/);

  assert.match(entrypoint, /Xvfb "\$display" -screen 0 "\$screen_size" -ac -nolisten tcp/);
  assert.match(entrypoint, /x11vnc/);
  assert.match(entrypoint, /-listen localhost/);
  assert.match(entrypoint, /websockify/);
  assert.match(entrypoint, /--web \/usr\/share\/novnc/);
  assert.match(entrypoint, /export DISPLAY="\$display"/);
  assert.match(entrypoint, /node dist\/index\.js/);
  assert.match(await read("src/adapters/browser/playwright-driver.ts"), /--no-sandbox/);
  assert.match(entrypoint, /api\/browser\/tabs/);
  assert.match(entrypoint, /Unable to start the real Chrome window/);
  assert.match(entrypoint, /trap cleanup EXIT INT TERM/);
  assert.match(entrypoint, /install -o pimuse -g pimuse -m 0600/);
  assert.match(entrypoint, /setpriv/);

  // 外部地址由 Docker 端口映射或反向代理决定；镜像和页面都不内置主机名。
  assert.match(compose, /\$\{PI_MUSE_BROWSER_PORT:-17890\}:17890/);
  assert.match(compose, /\$\{PI_MUSE_BROWSER_NOVNC_PORT:-6080\}:6080/);
  assert.match(compose, /^  pi-muse-browser:\n    platform: linux\/amd64$/m);
  assert.match(compose, /BROWSER_SCREEN_SIZE: \$\{BROWSER_SCREEN_SIZE:-1440x900x24\}/);
  assert.match(compose, /pi-muse-browser-data:\/app\/\.pi-muse/);
  assert.match(compose, /config\.json:\/app\/browser-config\.json:ro/);
  assert.doesNotMatch(compose, /localhost:\$\{|127\.0\.0\.1:\$\{/);
  assert.match(dockerignore, /^\.pi-muse$/m);
  assert.match(dockerignore, /^node_modules$/m);
});
