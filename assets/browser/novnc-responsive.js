/* 统一入口：桌面和手机共享 vnc.html，窄视口自动切到移动布局；同源代理下补齐 websockify 路径。 */
(() => {
  const mobileViewport = window.matchMedia("(max-width: 700px)");
  const currentPathname = window.location.pathname;

  // 在服务端同源桌面网关（/browser/desktop/ 前缀）下，官方 vnc.html 默认连接 /websockify，
  // 会脱离网关前缀而 404；若 query 和 hash 均未显式指定 path，将 path=browser/desktop/websockify
  // 注入 query，保留既有 query、hash 及显式的 host/port/path。
  if (currentPathname.startsWith("/browser/desktop/")) {
    const currentQuery = new URLSearchParams(window.location.search);
    const currentHash = new URLSearchParams(window.location.hash.slice(1));
    if (!currentQuery.has("path") && !currentHash.has("path")) {
      currentQuery.set("path", "browser/desktop/websockify");
      window.history.replaceState(null, "", `${currentPathname}?${currentQuery.toString()}${window.location.hash}`);
    }
  }

  const path = window.location.pathname;
  const onDesktopPage = path.endsWith('/vnc.html') || path.endsWith('/vnc_lite.html');
  const onMobilePage = path.endsWith('/pimuse-mobile.html');
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const layout = query.get('layout') ?? hash.get('layout') ?? 'auto';

  function syncPage() {
    if (layout === 'desktop' || layout === 'mobile') return;
    if (onDesktopPage && mobileViewport.matches) {
      window.location.replace(`./pimuse-mobile.html${window.location.search}${window.location.hash}`);
    } else if (onMobilePage && !mobileViewport.matches) {
      window.location.replace(`./vnc.html${window.location.search}${window.location.hash}`);
    }
  }

  mobileViewport.addEventListener('change', syncPage);
  syncPage();
})();
