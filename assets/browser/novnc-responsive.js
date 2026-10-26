/* 统一入口：桌面和手机共享 vnc.html，窄视口自动切到移动布局。 */
(() => {
  const mobileViewport = window.matchMedia('(max-width: 700px)');
  const path = window.location.pathname;
  const onDesktopPage = path.endsWith('/vnc.html') || path.endsWith('/vnc_lite.html');
  const onMobilePage = path.endsWith('/pimuse-mobile.html');

  function syncPage() {
    if (onDesktopPage && mobileViewport.matches) {
      window.location.replace(`./pimuse-mobile.html${window.location.search}${window.location.hash}`);
    } else if (onMobilePage && !mobileViewport.matches) {
      window.location.replace(`./vnc.html${window.location.search}${window.location.hash}`);
    }
  }

  mobileViewport.addEventListener('change', syncPage);
  syncPage();
})();
