# G 款冰蓝小企鹅资源包

更新日期：2026-10-26。

这份资源包目前包含透明角色基准、八个状态的静态初版、两个图标母版，以及待机、思考、工作三个状态的 Hailuo 连续动画初稿。其余五个状态还没有视频，时序 PNG 帧序列尚未导出。不要把独立关键帧拼起来当作完成的动画。

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

## 连续动画初稿

2026-10-26 使用 MiniMax Hailuo 2.3 图生视频，三个任务均成功并已下载。请求参数为 6 秒、768P；实测均为 768×768、24fps、141 帧、5.875 秒，无音轨。视频为 AI 生成素材。

| 状态 | MP4 | 抽帧预览 |
| --- | --- | --- |
| 待机 | [idle-hailuo-768p.mp4](videos/idle-hailuo-768p.mp4) | [idle-contact-sheet.png](previews/idle-contact-sheet.png) |
| 思考 | [thinking-hailuo-768p.mp4](videos/thinking-hailuo-768p.mp4) | [thinking-contact-sheet.png](previews/thinking-contact-sheet.png) |
| 工作 | [working-hailuo-768p.mp4](videos/working-hailuo-768p.mp4) | [working-contact-sheet.png](previews/working-contact-sheet.png) |

预览按从左到右、从上到下排列，采样帧为 0、28、56、84、112、140；不是完整时序帧包。

- 输出为不透明白底 H.264 MP4，没有保留参考 PNG 的透明通道。
- 首尾帧不同，尚未验收为无缝循环；提示词要求循环不等于输出已满足。
- 已抽帧初看，但尚未完成完整播放审阅或获得用户认可。待机抽帧中闭眼表现偏白，需重点确认是否可接受；工作动作偏轻，需播放确认小尺寸可读性。
- 本轮提交了三个有效任务，按用户提供的每日三条额度停止继续生成；未查询账户实际余额或计费归属。
- 只交付资源，没有修改客户端代码、替换现有头像或进行运行时播放验收。

## 资源交接

- [manifest.json](manifest.json)：八个状态的静态文件、状态依据及动画进度。
- [animation-briefs.json](animation-briefs.json)：八段连续动作的图生视频参考与提示词。时长、帧率是制作目标，不是已经生成的文件参数，也不是可直接执行的某个服务 API 请求。
- [generation-prompts.json](generation-prompts.json)：本包十张静态图实际使用的完整生图提示词、参考文件和来源校验值。
- [video-generation-log.json](video-generation-log.json)：三个视频的任务 ID、实测参数、执行提示词和校验值；不含 API Key 或临时下载链接。
- [asset-checks.json](asset-checks.json)：静态图、视频和抽帧预览的技术检查。

本轮已通过 MiniMax 国内 API `api.minimaxi.com` 跑通生成、查询和下载，不需要另接 Runway。剩余回复、等待确认、完成、失败、停止五个状态仍待生成。

先审阅这三条短片的动作和角色一致性，再决定后续批次与循环、背景处理方案。视频初稿不等于可直接上线的透明动画。
