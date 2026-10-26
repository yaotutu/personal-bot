# Gemini 手动视频清单

更新日期：2026-10-26。用于 Google AI Pro 的 Gemini 网页「生成视频」。

## 操作约定

操作与下载入口参考 [Gemini 官方说明](https://support.google.com/gemini/answer/16126339?hl=en)。官方说明确认：网页可上传参考图，上传图片后视频比例会跟随图片；生成后可通过 Download video 下载。具体每日额度以 Google 页面显示为准。

1. 打开 Gemini 网页，进入「生成视频」。
2. 每次只做一行任务；按表上传 `avatar/` 目录内指定参考图。上传图片后 Gemini 会沿用图片比例，通常为方形输出。
3. 复制对应提示词，关闭声音／音频；如果页面不能显式关闭音频，就在提示词保留 `No audio`，下载后由仓库任务统一去音轨。
4. 生成满意后点击视频下方 Share，选择 Download video。
5. 将下载文件重命名成目标文件名，放入本仓库的 `docs/assets/avatar/videos/`。文件名必须完全一致，不要包含空格或中文。
6. 如果页面额度不足，按表中顺序生成；优先补齐前三个。
7. 不要把生成结果放进其他目录；不要覆盖已有三条 Hailuo 视频。

## 上传文件位置

所有路径均相对仓库根目录：

```text
docs/assets/avatar/base.png
docs/assets/avatar/keyframes/error.png
docs/assets/avatar/keyframes/responding.png
docs/assets/avatar/keyframes/stopped.png
docs/assets/avatar/keyframes/success.png
docs/assets/avatar/keyframes/thinking.png
docs/assets/avatar/keyframes/waiting-approval.png
docs/assets/avatar/keyframes/working.png
docs/assets/avatar/reference.png
```

## 生成任务

优先顺序从上到下；前五行是需要补齐的素材。

| 优先级 | 状态 | 上传参考图 | 目标文件 | 播放 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | `responding` | `keyframes/responding.png` | `videos/responding-gemini-v1.mp4` | 循环 | 待生成 |
| 2 | `waiting-approval` | `keyframes/waiting-approval.png` | `videos/waiting-approval-gemini-v1.mp4` | 循环 | 待生成 |
| 3 | `success` | `keyframes/success.png` | `videos/success-gemini-v1.mp4` | 一次 | 待生成 |
| 4 | `error` | `keyframes/error.png` | `videos/error-gemini-v1.mp4` | 一次 | 待生成 |
| 5 | `stopped` | `keyframes/working.png`, `keyframes/stopped.png` | `videos/stopped-gemini-v1.mp4` | 一次 | 待生成 |
| 6 | `idle` | `base.png` | `videos/idle-hailuo-768p.mp4` | 循环 | 已有，不重复生成 |
| 7 | `thinking` | `keyframes/thinking.png` | `videos/thinking-hailuo-768p.mp4` | 循环 | 已有，不重复生成 |
| 8 | `working` | `keyframes/working.png` | `videos/working-hailuo-768p.mp4` | 循环 | 已有，不重复生成 |

## 提示词

八个状态都保留完整提示词，便于之后重做或替换。当前只需要执行「待生成」五行。

### responding（回复）

上传：`keyframes/responding.png`

目标：`videos/responding-gemini-v1.mp4`

状态：待生成。

```text
Use the uploaded image as the exact character identity and composition reference: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Replace the plain silver laptop with a contemporary Apple MacBook Pro with a recognisable silver aluminium unibody, rounded corners, thin black backlit keyboard, large glass trackpad, slim display, thin bezels, and premium soft-metal reflections. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and the MacBook Pro intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, watermark or extra objects. The seated penguin lightly types on the MacBook Pro with alternating short flipper movements, briefly looks up toward the viewer with an engaged smile, then returns to the starting pose. Keep the MacBook Pro rigid and do not add speech or lip sync. Return naturally to the starting pose so the action can loop.
```

### waiting-approval（等待确认）

上传：`keyframes/waiting-approval.png`

目标：`videos/waiting-approval-gemini-v1.mp4`

状态：待生成。

```text
Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. The penguin has stopped typing. Keep both flippers off the keyboard and resting away from the keys. It looks patiently at the viewer, blinks once, makes a very small expectant head tilt, then settles into the same waiting pose. The open laptop stays still; no typing or celebration. Return naturally to the starting pose so the action can loop.
```

### success（完成）

上传：`keyframes/success.png`

目标：`videos/success-gemini-v1.mp4`

状态：待生成。

```text
Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. Create one modest completion gesture: a gentle happy nod, brief soft eye-close and one small friendly flipper wave, then settle into a neutral standing pose with eyes open. No repeated waving, jumping or confetti.
```

### error（失败）

上传：`keyframes/error.png`

目标：`videos/error-gemini-v1.mp4`

状态：待生成。

```text
Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. Create one mild puzzled reaction: a small head tilt and a short open-flipper shrug, then settle calmly with flippers relaxed and eyes open. Do not cry, panic, shake violently or show anger.
```

### stopped（停止）

上传：`keyframes/working.png`, `keyframes/stopped.png`

目标：`videos/stopped-gemini-v1.mp4`

状态：待生成。

```text
Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. Create one calm user-requested stopping action, not a failure: the penguin lifts its flippers away from the keyboard, gently closes the laptop, and rests both flippers on the closed lid. End looking calmly at the viewer. End in the uploaded second image pose.
```

### idle（待机）

上传：`base.png`

目标：`videos/idle-hailuo-768p.mp4`

状态：已有 Hailuo 初稿；仅在明确决定重做时使用。

```text
Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. The standing penguin breathes subtly through its chest and shoulders, blinks naturally once, gently glances toward the viewer, and returns to the exact starting pose. Feet stay planted. Return naturally to the starting pose so the action can loop.
```

### thinking（思考）

上传：`keyframes/thinking.png`

目标：`videos/thinking-hailuo-768p.mp4`

状态：已有 Hailuo 初稿；仅在明确决定重做时使用。

```text
Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. Standing with one flipper near its beak, the penguin makes a small thoughtful head tilt, looks slightly upward, blinks, and returns to the exact starting pose. Keep it calm and friendly, not sad. Return naturally to the starting pose so the action can loop.
```

### working（工作）

上传：`keyframes/working.png`

目标：`videos/working-hailuo-768p.mp4`

状态：已有 Hailuo 初稿；仅在明确决定重做时使用。

```text
Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. The seated penguin concentrates on the laptop screen, typing with small alternating flipper movements, with gentle focused head motion and natural blinks. It does not turn to address the viewer. Keep the same laptop shape, face visible and feet planted. Return naturally to the starting pose so the action can loop.
```

## 下载后的整理

1. 先只放置 MP4，不改 `manifest.json`。
2. 告诉我“Gemini 视频已放入”，再由仓库任务统一检查时长、比例、音轨、画面动作、哈希和清单。
3. 若页面下载为 WebM 或其他格式，先保留原始下载文件并命名成类似 `responding-gemini-v1.original.webm`，同时告知我；不要手工改名冒充 MP4。
4. 本页只记录手动生成队列，不作为生成完成的证明。
