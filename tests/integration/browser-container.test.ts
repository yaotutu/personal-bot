import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = join(import.meta.dirname, "../..");
const read = (path: string) => readFile(join(root, path), "utf8");
const exec = promisify(execFile);

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
  assert.match(entrypoint, /BROWSER_WINDOW_SIZE/);
  assert.match(entrypoint, /session\.screen0\.toolbar\.visible: false/);
  assert.match(entrypoint, /chmod 0444 "\$fluxbox_init"/);
  assert.match(entrypoint, /SingletonLock/);

  assert.match(entrypoint, /Xvfb "\$display" -screen 0 "\$screen_size" -ac -nolisten tcp/);
  assert.match(entrypoint, /x11vnc/);
  assert.match(entrypoint, /-listen localhost/);
  assert.match(entrypoint, /websockify/);
  assert.match(entrypoint, /--web \/usr\/share\/novnc/);
  assert.match(entrypoint, /export DISPLAY="\$display"/);
  assert.match(entrypoint, /node dist\/index\.js/);
  assert.match(await read("src/adapters/browser/playwright-driver.ts"), /--no-sandbox/);
  assert.match(await read("src/adapters/browser/playwright-driver.ts"), /--window-position=0,0/);
  assert.match(await read("src/adapters/browser/playwright-driver.ts"), /--hide-crash-restore-bubble/);
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

test("mobile browser profile provides a portrait desktop without changing the desktop service", async () => {
  const compose = await read("compose.browser.yaml");
  const dockerfile = await read("Dockerfile");
  const page = await read("assets/browser/novnc-mobile.html");

  assert.match(dockerfile, /COPY assets\/browser\/novnc-mobile\.html \/usr\/share\/novnc\/pimuse-mobile\.html/);
  assert.match(dockerfile, /COPY assets\/browser\/novnc-responsive\.js \/usr\/share\/novnc\/pimuse-responsive\.js/);
  assert.match(dockerfile, /RUN node scripts\/install-novnc-responsive-entry\.mjs/);
  assert.match(compose, /^  pi-muse-browser:\n    platform: linux\/amd64$/m);
  assert.match(compose, /BROWSER_SCREEN_SIZE: \$\{BROWSER_SCREEN_SIZE:-1440x900x24\}/);
  assert.match(compose, /\$\{PI_MUSE_BROWSER_PORT:-17890\}:17890/);
  assert.match(compose, /\$\{PI_MUSE_BROWSER_NOVNC_PORT:-6080\}:6080/);
  assert.match(compose, /pi-muse-browser-data:\/app\/\.pi-muse/);

  assert.match(compose, /^  pi-muse-browser-mobile:\n    profiles:\n      - mobile$/m);
  assert.match(compose, /BROWSER_SCREEN_SIZE: \$\{PI_MUSE_BROWSER_MOBILE_SCREEN_SIZE:-720x1280x24\}/);
  assert.match(compose, /\$\{PI_MUSE_BROWSER_MOBILE_PORT:-18891\}:17890/);
  assert.match(compose, /\$\{PI_MUSE_BROWSER_MOBILE_NOVNC_PORT:-16081\}:6080/);
  assert.match(compose, /pi-muse-browser-mobile-data:\/app\/\.pi-muse/);
  assert.doesNotMatch(compose, /localhost|\b127\.0\.0\.1\b/);

  // 移动页仍直连完整远端桌面，不生成第二套浏览器外壳或地址栏。
  assert.match(page, /import RFB from '\.\/core\/rfb\.js'/);
  assert.match(page, /import Keyboard from '\.\/core\/input\/keyboard\.js'/);
  assert.match(page, /import KeyTable from '\.\/core\/input\/keysym\.js'/);
  assert.match(page, /import keysyms from '\.\/core\/input\/keysymdef\.js'/);
  assert.match(page, /const path = \(values\.get\('path'\) \|\| 'websockify'\)/);
  assert.match(page, /rfb\.scaleViewport = true/);
  assert.match(page, /rfb\.clipViewport = false/);
  assert.match(page, /rfb\.viewOnly = false/);
  assert.match(page, /touch-action: none/);
  assert.match(page, /viewport-fit=cover/);
  assert.match(page, /safe-area-inset/);
  assert.match(page, /keysyms\.lookup/);
  assert.match(page, /values\.get\('password'\)/);
  assert.match(page, /rfb\.sendCredentials\(\{ password \}\)/);
  assert.match(page, /<script src="pimuse-responsive\.js"><\/script>/);
  assert.doesNotMatch(page, /--headless|browser-address|address-bar/);
});

test("responsive entry injects a mobile redirect without replacing desktop vnc.html", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pimuse-novnc-"));
  const target = join(directory, "vnc.html");
  try {
    await writeFile(target, "<!doctype html><html><head><title>noVNC</title></head><body></body></html>");
    await exec(process.execPath, [join(root, "scripts/install-novnc-responsive-entry.mjs")], {
      env: { ...process.env, NOVNC_DIR: directory },
    });
    const first = await readFile(target, "utf8");
    assert.match(first, /<script src="pimuse-responsive\.js"><\/script>/);
    assert.match(first, /<title>noVNC<\/title>/);
    await exec(process.execPath, [join(root, "scripts/install-novnc-responsive-entry.mjs")], {
      env: { ...process.env, NOVNC_DIR: directory },
    });
    assert.equal(await readFile(target, "utf8"), first);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
