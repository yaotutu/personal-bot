# G 款冰蓝小企鹅资源包

更新日期：2026-10-26。

这份资源包目前包含透明角色基准、八个状态的静态初版和两个图标母版。**还没有连续动画、MP4 预览或按时间顺序导出的 PNG 帧序列。** 不要把这里的独立关键帧拼起来当作完成的动画。

用户选定的形象原图是 [penguin-style-g-ice-blue.png](../penguin-style-g-ice-blue.png)，本包没有修改原图，也没有修改 App 的代码、配置或现有资源引用。

## 静态资源

| 状态／用途 | 文件 | 内容 |
| --- | --- | --- |
| 透明基准／待机静态画面 | [base.png](base.png) | 正面站姿；待机复用此图，不重复存储相同文件 |
| 思考 | [thinking.png](keyframes/thinking.png) | 歪头，一侧翅膀靠近嘴部 |
| 回复 | [responding.png](keyframes/responding.png) | 坐在电脑前，抬头面向用户 |
| 工作 | [working.png](keyframes/working.png) | 坐在电脑前，注意力朝向屏幕 |
| 等待确认 | [waiting-approval.png](keyframes/waiting-approval.png) | 电脑保持打开，翅膀离开键盘，等待用户 |
| 完成 | [success.png](keyframes/success.png) | 闭眼微笑，轻抬一侧翅膀；是动作表现参考，不代表已经播放过挥手 |
| 失败 | [error.png](keyframes/error.png) | 轻微歪头、摊开翅膀，无惊恐或哭泣 |
| 停止 | [stopped.png](keyframes/stopped.png) | 合上电脑，平静地把翅膀放在盖子上，不表现成失败 |
| 图标母版 | [icon-master.png](icons/icon-master.png) | 头像特写，暖白底与浅冰蓝光晕；不透明 |
| 图标透明前景母版 | [foreground-master.png](icons/foreground-master.png) | 头像特写，有透明通道 |

十张 PNG 原图均为 1254×1254。图标母版还不是已经按 Android／iOS 规格导出的整套 launcher 图标，安全区和安装包效果没有验证。

## 检查范围与限制

- 已检查 PNG 文件存在、尺寸、透明通道和来源校验值，记录在 [asset-checks.json](asset-checks.json)。
- 已做初步形象和动作方向检查，但各图是独立生成的静态画面，不能保证角色位置、尺度、光照逐帧一致。
- 透明边缘仍有细毛白边和少量散点需要进一步审图；有透明通道不等于已经完成抠图边缘精修。
- 姿势和图标均为初版，待用户审阅；不能把用户选定 G 款角色理解为已审定所有派生图。
- 本包没有运行时播放验收，不提供伪造循环、淡入淡出或静态画面录屏来替代角色动画。

## 动画交接

- [manifest.json](manifest.json)：八个状态的静态文件、状态依据及动画进度。
- [animation-briefs.json](animation-briefs.json)：八段连续动作的图生视频参考与提示词。时长、帧率是制作目标，不是已经生成的文件参数，也不是可直接执行的某个服务 API 请求。
- [generation-prompts.json](generation-prompts.json)：本包十张静态图实际使用的完整生图提示词、参考文件和来源校验值。

目前没有已连接的连续视频生成工具。已查到 Runway 提供图生视频能力，并给出过连接入口；2026-10-26 核对仍未安装／连接，因此八段动画均记录为 `pending_video_connection`，动画路径为空。

连接视频工具后，再按这些参考制作真正的连续动作，检查角色一致性、自然运动、首尾衔接和透明背景交付能力。只有实际生成并检查过的短片，才能导出时序 PNG 帧和 MP4 预览。
