# Profile and settings

This page explains the mobile client's assistant and user profiles, common appearance settings, server connection and Android app updates. Entry points and limits were checked against current mobile and server source; source capabilities do not automatically equal a released APK. Follow the UI in your installed release.

## Prerequisites {#prerequisites}

- Complete the first connection as described in [Quick Start](getting-started.md#connect-mobile-client). Themes and app updates still work without a server connection, but profiles, memories, and Dream are unavailable.
- Assistant and user profiles are stored on the server and shared by all spaces. Theme preference is stored only on this device.

## Assistant and User Profile {#assistant-and-user-profile}

1. Go to bottom 「设置」 → 「助手与个人资料」 → 「助手与用户资料」. After a successful read, the page shows 「助手设置」 and 「人设与资料」.
2. Profile drafts belong only to the current workspace connection. Closing the panel or moving the app to the background does not actively clear them, but exiting the app, changing servers, or another workspace rebuild discards them.

### Save Assistant Settings {#save-assistant-settings}

1. Under 「助手设置」, enter the 「助手名字」. After trimming leading and trailing whitespace, it must contain 1–80 characters.
2. Choose one of the 「温暖」 (warm), 「简洁」 (concise), or 「周到」 (thoughtful) tones. If the server returns a legacy tone unknown to this client, the page shows that value and asks you to choose a supported one.
3. Tap 「保存助手设置」. Success shows 「身份已保存」, and the change marker disappears.

The name and tone are global and take effect from the next conversation turn; existing history is not rewritten. The assistant name is not used as the main-space title. The main-space header shows no name; other spaces show a readable number such as「空间 1」for the current connection only while the keyboard is closed.

### Save SOUL and USER {#save-soul-and-user}

1. Under 「SOUL · 助手人设」, describe the personality and working style you want. Under 「USER · 用户资料」, describe the background and preferences the assistant should know.
2. Each text field can contain at most 20,000 characters and may be empty. Tapping 「保存人设与资料」 submits both fields in one profile save. Clearing one section and saving clears that section.
3. Success shows 「人设已保存」. SOUL/USER take effect globally from the next conversation turn.
4. Tap 「取消助手设置修改」 or 「取消人设与资料修改」 to discard the corresponding draft and return to the last successfully loaded or saved values.

Assistant settings and SOUL/USER use different save actions; saving one does not automatically save the other. The SOUL/USER request saves the two texts sequentially, so in an exceptional case one may be saved while the other fails. On failure or an unknown result, keep the draft, refresh to verify, and explicitly save again only after checking.

Each profile section follows its own last successful save. The client does not automatically merge different drafts or provide version-conflict protection. SOUL/USER enters subsequent global model context and is sent to the external model service configured on the server; do not enter credentials or content you do not want to provide to that service. These custom instructions cannot expand tool permissions or file access or bypass file approvals.

## Appearance {#appearance}

1. Go to bottom 「设置」 → 「外观」.
2. Choose one of 「经典蓝白」 (Classic Blue), 「晨光白」 (Morning White), or 「深夜黑」 (Midnight Black). The interface switches immediately and tries to save the preference on this device.
3. If saving fails, the new theme remains visible but the page reports that the local preference was not saved. Choose a theme again to retry.
4. The light/dark shortcut in the header or Settings returns from dark mode to the most recently selected light theme; switching to dark mode uses 「深夜黑」.

Theme preference is stored separately from the server connection, AccessKey, Token, and business data. Changing servers or reauthenticating does not clear it. The setting affects only this device's interface.

## Server Connection {#server-connection}

For the first address, access key, and connection steps, see [Quick Start](getting-started.md#connect-mobile-client). To maintain the connection later:

1. Go to bottom 「设置」 → 「连接与设备」 → 「服务器连接」.
2. Edit 「服务器地址」 or 「访问密钥」, then tap 「保存」(Save). The app verifies the current input before saving; a separate test is not required.
3. Optionally tap 「测试连接」. Success shows 「连接正常」 and 「保存后生效」. Testing does not save configuration; editing either address or key immediately invalidates the test result.
4. To reauthenticate at the same address, enter the new access key and save. The app verifies that new key instead of reusing the old login. Leaving the key blank verifies and reuses the current login.
5. When changing servers, read the cleanup warning, tap 「确认清理」, then 「保存」. Failed verification does not clear old caches or overwrite the old connection.
6. Close the panel to cancel a test or verification before saving; tests can also be canceled with 「取消测试」. Late results cannot save anything. Actual configuration writes or local cleanup must finish before closing.
7. If the server is temporarily unavailable, tap 「重试连接」. If local configuration cannot be read, tap 「重新加载」.

Changing servers requires confirmation and discards local business caches and old credentials only after verification succeeds. It does not delete any remote server data, and the local theme preference is retained. Only a successful save writes the server address and server-issued long-term Token to the device, never the plaintext AccessKey.

The current app has no logout or server-sign-out button. Closing the connection panel clears only the access key entered in that form. Backgrounding or exiting pauses network requests but keeps the server address and Token for later use. The Token survives server restarts. Changing or removing `server.accessKey` makes the server reject old Tokens and the client requests reauthentication.

## Real Browser {#real-browser}

The real browser is configured and managed on the server. The mobile client has no browser-address setting or open-browser entry. Server browser tools and deployment capabilities are unchanged. To observe or control the remote desktop, open the protected deployment URL in a system browser as described in [Browser Docker and noVNC](browser-docker.md). noVNC is not protected by the Pi Muse API AccessKey; never expose an unauthenticated desktop publicly.

## Android App Updates {#android-updates}

1. Go to bottom 「设置」 → 「连接与设备」 → 「应用更新」. The app checks automatically when it starts in the foreground and once per hour while foregrounded. You can also tap 「立即检查更新」 or 「再次检查」.
2. Checking reads only the official GitHub repository's stable Release and accepts only a unique `app-release.apk`. Prereleases, drafts, and other assets are not used as update packages.
3. When a higher version is found, the app shows the current version, target version, and size, then starts downloading. You can cancel or retry the download and continue using the app; downloading may consume mobile data.
4. After the download finishes, the client opens the Android system installer. The first attempt may require allowing Pi Muse to install unknown apps, and the final installation must still be confirmed in the system UI. Opening the installer does not mean the upgrade completed.
5. If the check fails, the page shows the official APK URL and 「重新检查」. You can also open [pi-muse-mobile Releases](https://github.com/yaotutu/pi-muse-mobile/releases) to download manually and follow the system prompts.

The current update path supports only a standalone Android APK and is not Expo OTA. iOS, web previews, and Expo Go show that APK updates are unsupported; if the installed package version cannot be read, the app also directs you to use a formal APK manually. If you cancel installation while the system still retains the cached package, tap 「继续安装」. If Android clears the cache, download it again.

## Troubleshooting {#troubleshooting}

| Symptom | Check and action |
| --- | --- |
| Profile page shows the last loaded value or an unknown save result | Tap 「刷新」 to verify the server value. After checking, save explicitly again if needed; the client does not retry automatically. |
| Theme changed but saving failed | Local storage failed temporarily. Choose a theme again to retry saving; the visible switch is unaffected. |
| Connection status says reauthentication is required | Open 「服务器连接」, enter the current AccessKey, then tap 「保存」; it takes effect after verification succeeds. |
| App update check fails | Retry later or manually download the APK from the official Releases page. Update checks do not depend on the Pi Muse business server. |
