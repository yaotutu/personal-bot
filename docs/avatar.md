# 虚拟形象素材说明

更新日期：2026-10-26。

- 本地素材：`docs/assets/avatar/`。只分 `images/` 和 `videos/` 两个目录：前者放基准图、动作参考图和图标，后者放动画视频；动作用文件名区分，不再建动作子目录。
- 网页上传：打开 [Gemini](https://gemini.google.com/)的「生成视频」，按下方状态表上传指定 PNG，复制对应提示词；如页面不能显式关闭声音，保留提示词中的 `No audio`。生成后下载视频，操作参考 [Gemini 官方说明](https://support.google.com/gemini/answer/16126339?hl=en)。
- 剩余优先队列：`responding`、`waiting-approval`、`success`、`error`、`stopped`。额度不足时按此顺序生成，优先补齐前三条。
- 输出位置：新 MP4 放入 `docs/assets/avatar/videos/`，文件名使用状态表中的目标名。不要覆盖已有三条 Hailuo MP4。若下载得到 WebM 等真实格式，保留真实扩展名并另命名说明，不要只改成 `.mp4` 冒充转码。

```text
docs/assets/avatar/
  images/    基准图、动作参考图、图标母版
  videos/    已生成的动画视频
```

这套形象用于聊天页顶部和会话面板。本页只整理资源，不包含客户端实现，也没有替换当前 App 头像、接入播放器或修改服务端协议。

## 状态清单

| 状态 | phase/status 依据 | 动作区别 | 播放 | 静态文件 | 视频 |
| --- | --- | --- | --- | --- | --- |
| `idle` 待机 | 已同步且当前空间没有活动运行；不是额外枚举 | 自然呼吸、眨眼、轻微转头，脚保持站定 | 循环 | [base.png](assets/avatar/images/base.png) | [idle-hailuo-768p.mp4](assets/avatar/videos/idle-hailuo-768p.mp4) |
| `thinking` 思考 | `preparing`、`waiting_model` | 暂停动作、轻歪头并略抬头；不展示模型内部推理 | 循环 | [thinking.png](assets/avatar/images/thinking.png) | [thinking-hailuo-768p.mp4](assets/avatar/videos/thinking-hailuo-768p.mp4) |
| `responding` 回复 | `responding` | 坐姿轻敲电脑并短暂看向用户；与专注工作的动作保持区别 | 循环 | [responding.png](assets/avatar/images/responding.png)，当前图待用户反馈 | 待生成：`responding-gemini-v1.mp4` |
| `working` 工作 | `executing_tool`、`waiting_subagents`、`finalizing` | 面向屏幕连续打字，头、翅、身体有细微工作动作 | 循环 | [working.png](assets/avatar/images/working.png) | [working-hailuo-768p.mp4](assets/avatar/videos/working-hailuo-768p.mp4) |
| `waiting-approval` 等待确认 | `waiting_approval` 且有实际待审批信息 | 停止打字，翅离开键盘，耐心看向用户等待 | 循环 | [waiting-approval.png](assets/avatar/images/waiting-approval.png) | 待生成：`waiting-approval-gemini-v1.mp4` |
| `success` 完成 | `status=succeeded`，仅表示本轮执行成功 | 一次轻微点头、闭眼微笑和短促挥手，然后回到中性姿态 | 单次后回待机 | [success.png](assets/avatar/images/success.png) | 待生成：`success-gemini-v1.mp4` |
| `error` 失败 | `status=failed` | 轻微困惑、短促摊翅后平静安定；不惊恐、哭泣或愤怒 | 单次后保持静态或回待机，待确认 | [error.png](assets/avatar/images/error.png) | 待生成：`error-gemini-v1.mp4` |
| `stopped` 停止 | `status=cancelled` | 用户要求停止：离开键盘、合上电脑并平静看向用户；不是失败 | 单次后回待机 | [stopped.png](assets/avatar/images/stopped.png) | 待生成：`stopped-gemini-v1.mp4` |

八个状态的静态 PNG 已齐，待机复用 `base.png`，因此状态静态图总数仍是八张。它们是独立生成的初版参考，不是时序动画帧，不能把多张 PNG 拼接后宣称为连续动画。循环短片的约 4 秒自然回位和一次性短片的约 2 秒结束动作仍是制作目标。

## 其他素材

- [reference.png](assets/avatar/images/reference.png)：选定冰蓝小企鹅原图，1254×1254、暖白背景；形象内容未改动。
- [icon-master.png](assets/avatar/images/icon-master.png)：不透明头像特写母版，暖白底与浅冰蓝光晕。
- [foreground-master.png](assets/avatar/images/foreground-master.png)：透明前景头像特写母版。
- 图标只有两个设计母版；未导出 Android/iOS 平台尺寸，也未验证安全区或安装包效果。

## 已核事实与限制

- 现有 11 张 PNG 的历史测量均为 1254×1254；`reference.png` 和 `icon-master.png` 为不透明底，八张状态静态图和图标前景有透明通道。
- 三条 MP4 的历史测量均为 768×768、24fps、141 帧、5.875 秒、无音轨；本次整理只移动文件，没有重新解码测量。
- 仅 `idle`、`thinking`、`working` 有 MP4；另外五个状态还没有视频。
- 现有三条视频是白底 H.264 初稿，透明参考图在生成后变为不透明白底；首尾不同，尚未验收为无缝循环。
- 用户基本认可冰蓝小企鹅与当前动画方向，但不等于逐张图标、透明边缘、循环或运行时效果已完成验收。
- 图标母版未做平台验证；本页也不包含客户端实现或运行时播放验收。

## 视频提示词

以下八条提示词集中在本节，用于之后重做或替换。上传图片从 `docs/assets/avatar/images/` 取，生成的视频统一放入 `docs/assets/avatar/videos/`。下方上传与目标仅列文件名；未生成的目标文件不代表文件已存在。

### `responding`

上传：`responding.png`；目标：`responding-gemini-v1.mp4`

```text
Use the uploaded image as the exact first frame and preserve the character identity and composition: pale ice-blue head/back/flippers, cream face and belly, pink blush cheeks, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep the photorealistic classic silver Retina MacBook Pro from the reference unchanged, including its aluminium texture, machined edges, side ports, keyboard, proportions and position on the penguin's lap. Its centred white Apple logo must remain lit from within with steady brightness and a subtle soft halo throughout; never replace it with a dark logo, make it flicker or pulse, or turn it off. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Render the transparent background as plain white, keep all limbs and the MacBook Pro intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, watermark or extra objects. The seated penguin lightly types on the MacBook Pro with alternating short flipper movements, briefly looks up toward the viewer with an engaged smile, then returns to the starting pose. Keep the MacBook Pro rigid and do not add speech or lip sync. Return naturally to the starting pose so the action can loop.
```

### `waiting-approval`

上传：`waiting-approval.png`；目标：`waiting-approval-gemini-v1.mp4`

```text
Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. The penguin has stopped typing. Keep both flippers off the keyboard and resting away from the keys. It looks patiently at the viewer, blinks once, makes a very small expectant head tilt, then settles into the same waiting pose. The open laptop stays still; no typing or celebration. Return naturally to the starting pose so the action can loop.
```

### `success`

上传：`success.png`；目标：`success-gemini-v1.mp4`

```text
Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. Create one modest completion gesture: a gentle happy nod, brief soft eye-close and one small friendly flipper wave, then settle into a neutral standing pose with eyes open. No repeated waving, jumping or confetti.
```

### `error`

上传：`error.png`；目标：`error-gemini-v1.mp4`

```text
Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. Create one mild puzzled reaction: a small head tilt and a short open-flipper shrug, then settle calmly with flippers relaxed and eyes open. Do not cry, panic, shake violently or show anger.
```

### `stopped`

上传：`working.png`、`stopped.png`；目标：`stopped-gemini-v1.mp4`

```text
Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. Create one calm user-requested stopping action, not a failure: the penguin lifts its flippers away from the keyboard, gently closes the laptop, and rests both flippers on the closed lid. End looking calmly at the viewer. End in the uploaded second image pose.
```

### `idle`

上传：`base.png`；目标：`idle-hailuo-768p.mp4`

```text
Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. The standing penguin breathes subtly through its chest and shoulders, blinks naturally once, gently glances toward the viewer, and returns to the exact starting pose. Feet stay planted. Return naturally to the starting pose so the action can loop.
```

### `thinking`

上传：`thinking.png`；目标：`thinking-hailuo-768p.mp4`

```text
Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. Standing with one flipper near its beak, the penguin makes a small thoughtful head tilt, looks slightly upward, blinks, and returns to the exact starting pose. Keep it calm and friendly, not sad. Return naturally to the starting pose so the action can loop.
```

### `working`

上传：`working.png`；目标：`working-hailuo-768p.mp4`

```text
Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. The seated penguin concentrates on the laptop screen, typing with small alternating flipper movements, with gentle focused head motion and natural blinks. It does not turn to address the viewer. Keep the same laptop shape, face visible and feet planted. Return naturally to the starting pose so the action can loop.
```

## 来源与校验附录

<details>
<summary>保留生成来源、任务 ID 与 SHA256</summary>

三条既有视频于 2026-10-26 由 MiniMax Hailuo 2.3 图生视频生成，请求 6 秒、768P；按用户说明每天三条额度停止继续提交，未查询账户余额或计费归属。凭据未记录。

- `idle`：来源 `base.png`；task_id `456404912869691`；file_id `456405224571173`；SHA256 `ea55c4acb01a68238a94d7d7e356c6943ab7f360700438a82df86dc87e188c0f`。
- `thinking`：来源 `thinking.png`；task_id `456404822421943`；file_id `456404988059952`；SHA256 `7a62ff55a2d44d3c0abbd9442fcc5f0edd11c02a26a8ae535a344f28771998ab`。
- `working`：来源 `working.png`；task_id `456403763646900`；file_id `456404482396435`；SHA256 `4f1a78a6a08ac436b4fc4f5d23275aca3a63dac639161f91c3d060ba21293437`。

`responding.png` 是 2026-10-26 用内置 image_gen 对既有回复关键帧做精确对象替换得到，1254×1254 PNG RGBA，SHA256 `9edfb768cedcdd5b0b378c13179fe80da4de790880d06c9855415ebe949e214e`。旧深色标志版本被用户拒绝；修订版由 Agent 视觉检查，用户仍待反馈。最终生图提示词：

```text
Replace only the laptop with a photorealistic classic silver Retina MacBook Pro of the 2012-2015 design. Use finely bead-blasted aluminium, machined edges, realistic seams, ports, hinge and black chiclet keyboard. The centred bitten Apple logo and separate leaf must glow bright white from within, with restrained soft bloom on the silver lid, not a dark printed logo or neon outline. Preserve the ice-blue fluffy baby penguin, cream face and belly, pink cheeks, dark eyes, peach-orange beak and feet, crown tufts, seated pose, head tilt, smile, flipper at keyboard, framing and true transparent background. Keep one laptop on the lap, no extra objects, lettering or watermark.
```

</details>
