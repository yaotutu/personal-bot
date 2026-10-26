# 冰蓝小企鹅资源包

更新日期：2026-10-26。

这份资源包目前包含透明角色基准、八个状态的静态初版、两个图标母版，以及待机、思考、工作三个状态的 Hailuo 连续动画初稿。其余五个状态还没有视频，时序 PNG 帧序列尚未导出。不要把独立关键帧拼起来当作完成的动画。

用户于 2026-10-26 基本认可当前形象与动画方案。选定原图统一命名为 [reference.png](reference.png)，图像内容未改动。未采用的风格稿已删除，不再维护 A–H 候选编号。

## 目录

```text
avatar/
  reference.png       选定角色原图
  base.png            透明基准，兼作待机静态参考
  keyframes/          其余七个状态的静态参考
  icons/              两个图标母版
  videos/             已生成的三条 MP4
  manifest.json       状态、资源路径、来源与校验摘要
```

后续制作安排见[虚拟形象方案](../../product/avatar.md)，这里不另维护一份计划。

## 静态资源

| 状态／用途 | 文件 | 内容 |
| --- | --- | --- |
| 透明基准／待机静态画面 | [base.png](base.png) | 正面站姿；待机复用此图，不重复存储相同文件 |
| 思考 | [thinking.png](keyframes/thinking.png) | 歪头，一侧翅膀靠近嘴部 |
| 回复 | [responding.png](keyframes/responding.png) | 坐在电脑前，抬头面向用户；视频目标道具为 Apple MacBook Pro |
| 工作 | [working.png](keyframes/working.png) | 坐在电脑前，注意力朝向屏幕 |
| 等待确认 | [waiting-approval.png](keyframes/waiting-approval.png) | 电脑保持打开，翅膀离开键盘，等待用户 |
| 完成 | [success.png](keyframes/success.png) | 闭眼微笑，轻抬一侧翅膀；是动作表现参考，不代表已经播放过挥手 |
| 失败 | [error.png](keyframes/error.png) | 轻微歪头、摊开翅膀，无惊恐或哭泣 |
| 停止 | [stopped.png](keyframes/stopped.png) | 合上电脑，平静地把翅膀放在盖子上，不表现成失败 |
| 图标母版 | [icon-master.png](icons/icon-master.png) | 头像特写，暖白底与浅冰蓝光晕；不透明 |
| 图标透明前景母版 | [foreground-master.png](icons/foreground-master.png) | 头像特写，有透明通道 |

选定原图与十张派生 PNG 共十一张，均为 1254×1254。图标母版还不是已经按 Android／iOS 规格导出的整套 launcher 图标，安全区和安装包效果没有验证。

## 检查范围与限制

- PNG 尺寸、透明通道、视频解码和来源摘要在 [manifest.json](manifest.json) 中统一记录。
- 已做初步形象和动作方向检查，但各图是独立生成的静态画面，不能保证角色位置、尺度、光照逐帧一致。
- 透明边缘仍有细毛白边和少量散点需要进一步审图；有透明通道不等于已经完成抠图边缘精修。
- 用户基本认可整体方向；不等于每张图标、透明边缘和运行时效果均已完成验收。
- 本包没有运行时播放验收，不提供伪造循环、淡入淡出或静态画面录屏来替代角色动画。

## 连续动画初稿

2026-10-26 使用 MiniMax Hailuo 2.3 图生视频，三个任务均成功并已下载。请求参数为 6 秒、768P；实测均为 768×768、24fps、141 帧、5.875 秒，无音轨。视频为 AI 生成素材。

| 状态 | MP4 |
| --- | --- |
| 待机 | [idle-hailuo-768p.mp4](videos/idle-hailuo-768p.mp4) |
| 思考 | [thinking-hailuo-768p.mp4](videos/thinking-hailuo-768p.mp4) |
| 工作 | [working-hailuo-768p.mp4](videos/working-hailuo-768p.mp4) |

- 输出为不透明白底 H.264 MP4，没有保留参考 PNG 的透明通道。
- 首尾帧不同，尚未验收为无缝循环；提示词要求循环不等于输出已满足。
- 用户已基本认可当前动画方案；待机闭眼表现、工作动作的小尺寸可读性仍作为后续精修观察项，不因此重做已认可的方向。
- 本轮提交了三个有效任务，按用户提供的每日三条额度停止继续生成；未查询账户实际余额或计费归属。
- 只交付资源，没有修改客户端代码、替换现有头像或进行运行时播放验收。

## 资源交接

- [manifest.json](manifest.json)：状态映射、资源路径、MiniMax 任务来源和校验摘要。
- [Google 手动视频清单](../../product/google-video-queue.md)：剩余五个状态的完整提示词和目标文件名。

本轮已通过 MiniMax 国内 API `api.minimaxi.com` 跑通生成、查询和下载，不需要另接 Runway。剩余回复、等待确认、完成、失败、停止五个状态仍待生成。

继续沿用当前形象与图生视频方案，不重新选风格。视频初稿不等于可直接上线的透明动画；本轮没有修改 App 代码、配置或资源引用。
