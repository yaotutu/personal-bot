# T1 移动端静态素材交接

本包从已确认的 T1 浅底图稿 `previews/neutral-icon-master.png` 及其确定性透明抠图派生。`delivery/pi-muse-client-assets.zip` 内的 `assets/` 与下表 `client/` 保持同名目录结构；`asset-guide.md` 是本页副本。复制所需 PNG 到移动端的 `assets/` 后，按现有配置逐项接入。本包不修改移动端仓库。

项目级来源为 `docs/assets/brand/`，确认稿 SHA-256 为 `53182c9e203f7dfb5d6af30202862e851fabc2a565a276b62f79a79e96850245`。表中的“已引用”只表示客户端已经使用同名目标路径，不表示本包的新 T1 图片已复制到应用；本轮没有替换任何手机运行资源。

| 本目录源文件 | 移动端目标 | 用途与当前引用 |
| --- | --- | --- |
| `client/icon.png` | `assets/icon.png` | iOS/通用 launcher 源图；当前 `app.json` 已引用同名目标 |
| `client/android-icon-foreground.png` | `assets/android-icon-foreground.png` | Android adaptive 前景；当前已引用同名目标 |
| `client/android-icon-background.png` | `assets/android-icon-background.png` | Android adaptive 背景；当前已引用同名目标 |
| `client/android-icon-monochrome.png` | `assets/android-icon-monochrome.png` | Android 主题单色层；当前已引用同名目标 |
| `client/favicon.png` | `assets/favicon.png` | Web favicon；当前已引用同名目标 |
| `client/images/muse-companion.png` | `assets/images/muse-companion.png` | 静态默认形象；`MuseAvatar` 当前引用该目标路径，使用 `resizeMode=cover` 和圆形遮罩；移动端现有文件尚未替换 |
| `client/splash-icon.png` | `assets/splash-icon.png` | 供后续启动页接入；移动端目标路径已有文件，但 `app.json` 尚未配置 `expo-splash-screen` 插件，本包未启用启动页 |
| `client/web/icon-16.png` | `assets/web/icon-16.png` | 备选 Web 16 px 图；当前未引用 |
| `client/web/icon-32.png` | `assets/web/icon-32.png` | 备选 Web 32 px 图；当前未引用 |
| `client/web/icon-192.png` | `assets/web/icon-192.png` | 备选 Web 192 px 图；当前未引用 |
| `client/web/icon-512.png` | `assets/web/icon-512.png` | 备选 Web 512 px 图；当前未引用 |

当前已配置的五个图片槽位（通用图标、Android 三层、Web favicon）均已提供对应素材。头像是单张静态默认形象，没有动画状态。Expo 在应用构建时负责生成所需密度和平台尺寸；本包不是 Android/iOS 原生资源 catalog，也不是 Icon Composer `.icon`。现有按钮和导航图标由 `lucide-react-native` 矢量资源维护；当前没有通知小图标或商店页素材需求。

Android 背景层使用协调浅色 `#F1F6FA`。这是派生色，不是从母版精确采样得到的品牌标准色。接入 `backgroundImage` 时，应同步设置相同的 `backgroundColor` 作为纯色兜底，并在现有 `app.json` 中局部修改相关字段，不覆盖整个配置。启动图与 Android 前景是**字节相同**的 1024 × 1024 RGBA PNG；其非零 alpha 均位于中央 2/3 直径圆内。启动页接入后仍需用 preview/production 原生构建验收；Expo Go 不能替代。静态预览只是 asset mock，未做系统图标安装、启动页原生显示或应用运行验收。

平台依据见 [Expo 图标与启动页说明](https://docs.expo.dev/develop/user-interface/splash-screen-and-app-icon/)和 [Android 启动图安全区](https://developer.android.com/develop/ui/views/launch/splash-screen)。

旧 A13 图标、桃色背景 T1、失败透明草稿和毛绒企鹅动画均属历史探索，保留原位置，不进入当前交接包，也不用于当前 T1 接入。包内 `checksums.sha256` 校验 `assets/` PNG 与 `asset-guide.md`；外部 `manifest.json` 记录交接包哈希与素材尺寸。
