# 虚拟形象素材说明

更新日期：2026-10-26。

本地素材按动作整理在 `docs/assets/avatar/` 下。每个动作目录包含自己的 PNG、已有或待补视频，以及记录上传方式、生成提示词和来源的 `README.md`。本页只做导航和共同规则说明；八段视频提示词及回复动作的生图提示词分别维护在动作目录中。

这套形象用于聊天页顶部和会话面板。这里不包含客户端实现，也没有替换当前 App 头像、接入播放器或修改服务端协议。

## 动作目录

| 动作入口 | 视频进度 |
| --- | --- |
| [idle 待机](assets/avatar/idle/README.md) | 已有 Hailuo 初稿 |
| [thinking 思考](assets/avatar/thinking/README.md) | 已有 Hailuo 初稿 |
| [responding 回复](assets/avatar/responding/README.md) | 待生成；当前静态图待用户反馈 |
| [working 工作](assets/avatar/working/README.md) | 已有 Hailuo 初稿 |
| [waiting-approval 等待确认](assets/avatar/waiting-approval/README.md) | 待生成 |
| [success 完成](assets/avatar/success/README.md) | 待生成 |
| [error 失败](assets/avatar/error/README.md) | 待生成 |
| [stopped 停止](assets/avatar/stopped/README.md) | 待生成 |

待生成优先顺序：`responding`、`waiting-approval`、`success`、`error`、`stopped`。额度不足时按此顺序补齐。

## 上传与生成

1. 打开 [Gemini](https://gemini.google.com/)的「生成视频」。
2. 从目标动作目录上传其 `README.md` 指定的 PNG，并复制该动作目录中的完整英文提示词。
3. 生成后直接下载到同一动作目录，使用 `README.md` 指定的目标文件名；不要覆盖已有 Hailuo MP4。
4. 如页面不能显式关闭声音，保留提示词中的 `No audio`。操作参考 [Gemini 官方说明](https://support.google.com/gemini/answer/16126339?hl=en)。

所有上传素材和下载视频都留在对应动作文件夹。若实际下载格式是 WebM 等，应保留真实扩展名并同步修改文件名说明，不能只改成 `.mp4` 冒充转码。待生成文件名只是命名约定，链接文字不代表文件已经存在。

用户说明 MiniMax 每天有 3 条生成额度；本次未查询账户余额或计费归属。

## 共用基准素材

- [reference.png](assets/avatar/base/reference.png)：选定冰蓝小企鹅原图，1254x1254、暖白背景；形象内容未改动。
- [icon-master.png](assets/avatar/base/icon-master.png)：不透明头像特写母版，暖白底与浅冰蓝光晕。
- [foreground-master.png](assets/avatar/base/foreground-master.png)：透明前景头像特写母版。

图标只有两个设计母版；未导出 Android/iOS 平台尺寸，未验证安全区或安装包效果，也不包含 App 实现。

## 共同规格与限制

- 仅 `idle`、`thinking`、`working` 有视频；另外五个动作没有视频。现有视频共三条，于 2026-10-26 由 MiniMax Hailuo 2.3 图生视频生成，请求 6 秒、768P；凭据未记录。
- 11 张 PNG 的历史测量均为 1254x1254；`reference.png` 和 `icon-master.png` 为不透明底，八张状态静态图和图标前景有透明通道。此尺寸是历史测量，不是本次重测。
- 三条 MP4 的历史测量均为 768x768、24fps、141 帧、5.875 秒、无音轨；本次整理只移动文件，没有重新解码测量。
- 八张状态静态图是独立生成的初版参考，不是时序动画帧，不能把多张 PNG 拼接后宣称为连续动画。待机复用 `idle/base.png`。
- 三条既有视频是白底 H.264 初稿，透明参考图在生成后变为不透明白底；首尾不同，尚未验收为无缝循环。
- 循环短片的约 4 秒自然回位和一次性短片的约 2 秒结束动作仍是制作目标。
- 用户基本认可冰蓝小企鹅与当前动画方向，但不等于逐张图标、透明边缘、循环或运行时效果已完成验收。
