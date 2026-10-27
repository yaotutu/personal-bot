# waiting-approval 等待确认

[返回素材总览](../../../avatar.md)

![waiting-approval 等待确认](waiting-approval.png)

- 中文动作名：等待确认。
- phase/status 依据：`waiting_approval` 且有实际待审批信息。
- 动作：停止打字，翅离开键盘，耐心看向用户等待。
- 输出比例：正方形 `1:1`，视频文件的像素宽高必须相等；不是横版或竖版。
- 播放方式：循环。
- 上传图片：`waiting-approval.png`（本目录）。
- 已有视频：[waiting-approval-hailuo-768p.mp4](waiting-approval-hailuo-768p.mp4)。

## 视频提示词

用于生成该动作视频；上传图片见上方说明，下载后按目标文件名放回本目录。

```text
Required output format: a true square 1:1 video canvas with equal pixel width and height. The actual video file must be square, not a landscape 16:9 or portrait 9:16 video. Do not place square content inside a rectangular frame; no letterboxing, pillarboxing, black bars or borders. Compose directly for the square canvas and keep the entire penguin, crown tuft, feet and any laptop fully visible throughout the motion, with safe margins and no cropped limbs or props.

Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. The penguin has stopped typing. Keep both flippers off the keyboard and resting away from the keys. It looks patiently at the viewer, blinks once, makes a very small expectant head tilt, then settles into the same waiting pose. The open laptop stays still; no typing or celebration. Return naturally to the starting pose so the action can loop.
```

## 来源与校验

- 视频来源：2026-10-27 由 MiniMax `MiniMax-Hailuo-2.3` 图生视频生成；task_id `456850589647074`，file_id `456850746024162`，SHA256 `32d035f86a3ad37017cb788c6d0f6005648f8bd1e90f5b82b986d2c6ddf5411f`。
- 技术校验：768x768、24fps、141 帧、5.875 秒、H.264、无音轨。
- 视觉初检：停住不动、注视用户、眨眼和轻微歪头可读；参考图本身仍有翅靠近键盘，与“双手离开键盘”的目标存在偏差，待用户确认是否接受。
