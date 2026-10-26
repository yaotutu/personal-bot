# 虚拟形象与动作资源

更新日期：2026-10-26。

当前阶段：用户基本认可冰蓝小企鹅与当前动画方案。已有待机、思考、工作三条 Hailuo 白底 MP4 初稿；回复、等待确认、完成、失败、停止可通过 Gemini 网页手动补充。没有时序 PNG 帧包，循环与背景处理尚未验收。

## 1. 用途与范围

虚拟形象显示在聊天页顶部的会话信息区，以及打开后的会话面板中。需要的是角色本身的动作，例如眨眼、转头、操作电脑、停下等待，不是只对一张静态头像做缩放或增加光圈。

本项工作只负责资源清单与素材准备，不负责修改服务端协议、客户端状态映射或动画播放器。资源清单应以现有客户端能拿到的状态为依据。

角色方向已明确为可爱的小企鹅，参考 Muse 的柔和、亲近的质感。用户要求更可爱、浅色系，不要很深的颜色，并已选定冰蓝小企鹅。后续图标和动作以选定原图作为形象参考，不再回到深蓝、深灰方案，也不继续沿用旧毛绒角色作为新资源的默认形象。

### 当前方案与续作方式

用户已选定冰蓝小企鹅，并于 2026-10-26 基本认可当前静态与 Hailuo 动画方向。不再重新筛选风格，也不再维护 A—H 候选编号；未采用的候选图和提示词已删除，避免误用。

- 选定原图：[reference.png](../assets/avatar/reference.png)，1254×1254、暖白背景。
- 透明基准：[base.png](../assets/avatar/base.png)，兼作待机静态参考。
- 图标母版：[icon-master.png](../assets/avatar/icons/icon-master.png)、[foreground-master.png](../assets/avatar/icons/foreground-master.png)。
- 视频母版：[videos/](../assets/avatar/videos/)；来源与校验摘要在[manifest.json](../assets/avatar/manifest.json)。

用户还可用 Google AI Pro 的 Gemini 网页「生成视频」补充素材。手动生成清单见[Google 手动视频清单](google-video-queue.md)；操作时上传该清单指定的参考图，下载后按清单文件名放入 `docs/assets/avatar/videos/`。这解决了每天三条 Hailuo 的额度限制，但仍由用户手动上传和下载，不是已接入自动化服务。

## 2. 已有的状态能力

服务端已经产生运行阶段和执行结果，客户端也已经解析并接收，不需要为下面这些状态新增服务端协议。

- 运行阶段 `phase`：`preparing`、`waiting_model`、`responding`、`executing_tool`、`waiting_subagents`、`waiting_approval`、`finalizing`。
- 运行状态 `status`：`running` 为执行中；`succeeded`、`failed`、`cancelled` 为三个终态，终态的 `phase` 为 `null`。
- 待机不是额外的服务端枚举，而是状态已同步、当前空间没有活动运行时的客户端判断。
- 连接、认证和状态同步由客户端单独维护。状态未知不能冒充任务失败，也不能因为断线就断言服务端已经停止执行。

核对入口：服务端 [agent-status.ts](https://github.com/yaotutu/pi-muse/blob/main/src/features/workspace/agent-status.ts)、[workspace-events.ts](https://github.com/yaotutu/pi-muse/blob/main/src/features/workspace/workspace-events.ts)；客户端 [runtime/types.ts](https://github.com/yaotutu/pi-muse-mobile/blob/main/src/runtime/types.ts)、[runtime/contracts.ts](https://github.com/yaotutu/pi-muse-mobile/blob/main/src/runtime/contracts.ts)、[runtime-store.ts](https://github.com/yaotutu/pi-muse-mobile/blob/main/src/runtime/runtime-store.ts)。链接指向各仓库当前主分支，不是把本页作为第二份协议规范。

状态数据已具备，不代表角色动作已接入。现有静态头像和品牌资源分支中的呼吸、光环效果，都不等于下面要求的角色动作。

## 3. 动作资源清单

本轮按下面八类准备资源，不擅自缩减为三套、四套或把停止复用为失败。这是 Pi Muse 的动作方案，不是 Muse 官方公布的动作清单。八套静态参考已齐，待机、思考、工作另有连续动画初稿；不把初稿视为可上线成品。

| 资源名 | 角色状态 | 现有状态依据 | 动作方向，待定稿 | 播放需求 | 资源情况 |
| --- | --- | --- | --- | --- | --- |
| `idle` | 待机 | 已同步且没有活动运行；终态反馈结束后也可回到这里 | 自然眨眼、轻微转头和身体起伏 | 循环 | [静态初版](../assets/avatar/base.png)已生成；[动画初稿](../assets/avatar/videos/idle-hailuo-768p.mp4)已生成，白底／循环待验收 |
| `thinking` | 思考／等待模型 | `preparing`、`waiting_model` | 暂停手上动作，抬头或轻微歪头 | 循环 | [静态初版](../assets/avatar/keyframes/thinking.png)已生成；[动画初稿](../assets/avatar/videos/thinking-hailuo-768p.mp4)已生成，白底／循环待验收 |
| `responding` | 正在回复 | `responding` | 输入内容，偶尔看向用户；与工作动作保持区别 | 循环 | [静态初版](../assets/avatar/keyframes/responding.png)已生成；动画未生成 |
| `working` | 正在工作 | `executing_tool`、`waiting_subagents`、`finalizing` | 专注操作电脑，头部、手部和身体有连续动作 | 循环 | [静态初版](../assets/avatar/keyframes/working.png)已生成；[动画初稿](../assets/avatar/videos/working-hailuo-768p.mp4)已生成，白底／循环待验收 |
| `waiting-approval` | 等待确认 | `waiting_approval`，并有实际待审批信息 | 停下工作，抬头看向用户，保持等待姿态 | 循环 | [静态初版](../assets/avatar/keyframes/waiting-approval.png)已生成；动画未生成 |
| `success` | 本轮执行成功 | `status=succeeded`，不等于所有目标或整项工作都已完成 | 简短点头或完成手势 | 播放一次，再回待机 | [静态初版](../assets/avatar/keyframes/success.png)已生成；动画未生成 |
| `error` | 本轮执行失败 | `status=failed` | 停下动作，轻微困惑，不使用强烈惊恐表情 | 播放一次，再保持静态或回待机，待确认 | [静态初版](../assets/avatar/keyframes/error.png)已生成；动画未生成 |
| `stopped` | 执行已停止 | `status=cancelled` | 收住当前动作，回到待机；不要表现成失败 | 播放一次，再回待机 | [静态初版](../assets/avatar/keyframes/stopped.png)已生成；动画未生成 |

八个状态已有各自可单独查看的静态参考，待机复用基准图。它们是生图工具独立生成的画面，不能作为时序动画帧；最终播放所需的静态帧是否改为从实际动画选取，仍需在短片完成后决定。

本轮保留回复／工作、失败／停止的区别。不能为了复用素材就把用户主动停止表现为失败。

“思考”仅表示准备或等待模型，不展示、猜测模型内部的推理内容。子代理工作与保存结果暂归入工作动作，下方文字继续说明具体进度，不另外扩展未经确认的动作类别。

## 4. 不单独制作的动作

- 断线、重连、状态待同步、认证失效：使用静态形象和明确的文字提示，不编造角色正在工作或工作失败。
- 系统减少动画、页面不可见或应用进入后台：是播放条件，不是新的角色动作素材。
- 聆听、语音口型、睡眠等：当前不在本次资源范围内，不为尚未确定的功能提前制作。

## 5. 当前素材与缺口

| 素材 | 位置 | 当前情况 |
| --- | --- | --- |
| 选定角色与透明基准 | [avatar/](../assets/avatar/README.md) | 已保留；原图内容未改，统一命名为 `reference.png` |
| 八个状态静态参考 | [keyframes/](../assets/avatar/keyframes/) | 已齐；边缘与跨姿势一致性仍需精修 |
| 图标母版 | [icons/](../assets/avatar/icons/) | 两个母版已保留；平台尺寸和安全区未导出 |
| 连续动作 | [videos/](../assets/avatar/videos/) | 待机、思考、工作已有初稿；其余五条待手动生成 |
| 来源与校验摘要 | [manifest.json](../assets/avatar/manifest.json) | 已保留；后续放入新文件后需重新校验并更新 |
| Gemini 手动生成清单 | [Google 手动视频清单](google-video-queue.md) | 剩余五条状态的提示词、上传图、目标文件名 |
| 当前客户端旧头像 | 移动端仓库资源 | 未替换；不属于本 README 资源包 |

废弃风格稿、旧企鹅初稿和未引用截图已删除。当前资源只保留一个角色方案，避免后续生成时混用形象。

## 6. 媒体格式与交付规格

**当前实际交付为静态 PNG 和三条白底 MP4 初稿。** 静态角色与图标母版均为 1254×1254；除不透明图标母版外，角色静态图与图标前景具有透明通道。视频为 768×768；均未经过客户端尺寸导出或运行时集成。

待机、思考、工作均请求 6 秒、768P，实测为 768×768、24fps、141 帧、5.875 秒的无声 H.264 MP4。透明参考图在视频中变为不透明白底；首尾不同，尚非验收过的无缝循环。关键任务与哈希见[manifest.json](../assets/avatar/manifest.json)。其他提示词中的约 4 秒循环、约 2 秒结束动作仍为制作目标。

已通过用户提供的 MiniMax 凭据调用国内 API `api.minimaxi.com`，完成三个任务的提交、状态查询和下载，不需要额外接入 Runway。按用户说明的每天三条额度，本轮不再提交新任务；未核对账户余额或计费归属。密钥不写入仓库、生成记录或客户端。

之前提出的 sprite sheet 仍只是可能的打包方式，不是制作源；最终 App 播放格式、透明动画交付方式和平台兼容性还需确认。

以下规格也都待定：

- 输出尺寸、画面安全区与角色在画面中的占比。
- 帧率、循环时长、一次性动作时长。
- 是否需要透明背景，浅色／深色界面怎样呈现。
- 如采用序列帧：帧数、网格排列、帧顺序及播放描述文件。
- 如采用其他动画格式：循环段、结束画面、静态画面的交付方式。

无论最终格式如何，各状态都应保持同一角色、材质、镜头、光照和画面尺度；循环首尾自然衔接，切换时不明显跳位。不能只交一张多格图片，就宣称已经完成流畅动画。

## 7. 剩余交付

1. 审阅派生静态初版，特别是不同姿势的角色尺度、透明细毛边缘与少量散点；有透明通道不等于已经完成边缘精修。
2. 按 [Google 手动视频清单](google-video-queue.md) 补齐回复、等待确认、完成、失败、停止五条视频；如果页面额度不足，优先回复、等待确认、完成。
3. 检查动作自然度、角色一致性、首尾衔接，以及透明背景交付能力，再导出时序帧和 MP4 预览。
4. 根据最终使用平台导出图标尺寸与安全区版本；当前只有母版，没有正式安装包验证结果。
5. 在本页和资源包清单中更新实际完成的文件；未生成的动画路径保持为空，不预填不存在的交付文件。

本页只记录资源需求与准备情况。状态切换、终态动作触发和播放控制由实现侧负责，本项不顺带修改代码。
