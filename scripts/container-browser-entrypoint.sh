#!/bin/sh
set -eu

# 一个容器就是一个远程浏览器工作站：Xvfb 提供真实 GUI 所需的 X server，
# x11vnc 把这个 X server 暴露给容器内的 websockify/noVNC，Node 服务负责 API/Agent。
config_source="${BROWSER_CONFIG_SOURCE:-/app/browser-config.json}"
display_number="${BROWSER_DISPLAY_NUMBER:-0}"
screen_size="${BROWSER_SCREEN_SIZE:-1440x900x24}"
vnc_port="${BROWSER_VNC_PORT:-5900}"
novnc_port="${BROWSER_NOVNC_PORT:-6080}"
children=""

fail() {
  echo "$1" >&2
  exit 2
}

case "$display_number" in
  ''|*[!0-9]*) fail "BROWSER_DISPLAY_NUMBER must be a non-negative integer" ;;
esac
case "$vnc_port" in
  ''|*[!0-9]*) fail "BROWSER_VNC_PORT must be an integer" ;;
esac
case "$novnc_port" in
  ''|*[!0-9]*) fail "BROWSER_NOVNC_PORT must be an integer" ;;
esac
echo "$screen_size" | grep -Eq '^[0-9]+x[0-9]+x[0-9]+$' \
  || fail "BROWSER_SCREEN_SIZE must look like 1440x900x24"

# Docker 以 root 进入只做两件事：把只读挂载的配置放进可写 volume、修正数据属主，
# 然后立即降权到 pimuse。浏览器、X server 和 Node 服务都不以 root 运行。
if [ "$(id -u)" -eq 0 ]; then
  [ -f "$config_source" ] || fail "Missing browser config file: $config_source"
  run_uid="$(id -u pimuse)"
  run_gid="$(id -g pimuse)"
  mkdir -p /app/.pi-muse
  install -o pimuse -g pimuse -m 0600 "$config_source" /app/.pi-muse/config.json
  chown -R pimuse:pimuse /app/.pi-muse
  exec setpriv \
    --reuid="$run_uid" \
    --regid="$run_gid" \
    --init-groups \
    "$0" --child
fi
if [ "${1:-}" != "--child" ] || [ "$(id -u)" -ne "$(id -u pimuse)" ]; then
  fail "This entrypoint must run as root and drop privileges to pimuse"
fi

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$children" ]; then
    # shellcheck disable=SC2086
    kill $children 2>/dev/null || true
    # shellcheck disable=SC2086
    wait $children 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

display=":${display_number}"
x_socket="/tmp/.X11-unix/X${display_number}"
x_lock="/tmp/.X${display_number}-lock"
rm -f "$x_socket" "$x_lock"

Xvfb "$display" -screen 0 "$screen_size" -ac -nolisten tcp &
xvfb_pid=$!
children="$children $xvfb_pid"

ready=0
i=0
while [ "$i" -lt 100 ]; do
  if [ -S "$x_socket" ] && kill -0 "$xvfb_pid" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    fail "Xvfb exited before the X socket became ready"
  fi
  sleep 0.1
  i=$((i + 1))
done
[ "$ready" -eq 1 ] || fail "Xvfb did not become ready"

fluxbox --display "$display" >/tmp/fluxbox.log 2>&1 &
children="$children $!"
x11vnc \
  -display "$display" \
  -listen localhost \
  -rfbport "$vnc_port" \
  -forever -shared -noxdamage -nopw \
  >/tmp/x11vnc.log 2>&1 &
children="$children $!"
websockify \
  --web /usr/share/novnc \
  "$novnc_port" \
  "127.0.0.1:${vnc_port}" \
  >/tmp/websockify.log 2>&1 &
children="$children $!"

novnc_ready=0
i=0
while [ "$i" -lt 100 ]; do
  if curl -fsS "http://127.0.0.1:${novnc_port}/vnc.html" >/dev/null 2>&1; then
    novnc_ready=1
    break
  fi
  sleep 0.1
  i=$((i + 1))
done
[ "$novnc_ready" -eq 1 ] || fail "noVNC did not become ready; see /tmp/websockify.log"

export DISPLAY="$display"
echo "pi-muse browser container ready: API port 17890, noVNC port ${novnc_port}, display ${display}"
node dist/index.js &
node_pid=$!
children="$children $node_pid"
api_ready=0
i=0
while [ "$i" -lt 300 ]; do
  if curl -fsS http://127.0.0.1:17890/api/health >/dev/null 2>&1; then
    api_ready=1
    break
  fi
  if ! kill -0 "$node_pid" 2>/dev/null; then
    fail "Node service exited before API health became ready"
  fi
  sleep 0.1
  i=$((i + 1))
done
[ "$api_ready" -eq 1 ] || fail "API health did not become ready"

# noVNC 打开时就应看到真实 Chrome 窗口；读取一次标签列表会触发懒启动，
# token 只留在这个短生命周期 Node 进程内，不写入参数、日志或镜像。
if ! node <<'NODE'
const { readFile } = require("node:fs/promises");
const main = async () => {
  const config = JSON.parse(await readFile("/app/.pi-muse/config.json", "utf8"));
  const login = await fetch("http://127.0.0.1:17890/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessKey: config.server?.accessKey ?? "" }),
  });
  if (!login.ok) throw new Error(`browser session login failed: ${login.status}`);
  const { token } = await login.json();
  const tabs = await fetch("http://127.0.0.1:17890/api/browser/tabs", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!tabs.ok) throw new Error(`browser startup failed: ${tabs.status}`);
};
main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
then
  fail "Unable to start the real Chrome window"
fi
wait "$node_pid"
