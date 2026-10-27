# success 完成

[返回素材总览](../../../avatar.md)

![success 完成](success.png)

- 中文动作名：完成。
- phase/status 依据：`status=succeeded`，仅表示本轮执行成功。
- 动作：一次轻微点头、闭眼微笑和短促挥手，然后回到中性姿态。
- 输出比例：正方形 `1:1`，视频文件的像素宽高必须相等；不是横版或竖版。
- 播放方式：单次后回待机。
- 上传图片：`success.png`（本目录）。
- 已有视频：[success-hailuo-768p.mp4](success-hailuo-768p.mp4)。

## 视频提示词

用于生成该动作视频；上传图片见上方说明，下载后按目标文件名放回本目录。

```text
Required output format: a true square 1:1 video canvas with equal pixel width and height. The actual video file must be square, not a landscape 16:9 or portrait 9:16 video. Do not place square content inside a rectangular frame; no letterboxing, pillarboxing, black bars or borders. Compose directly for the square canvas and keep the entire penguin, crown tuft, feet and any laptop fully visible throughout the motion, with safe margins and no cropped limbs or props.

Use the uploaded image as the exact first frame and preserve this identity exactly: pale ice-blue head/back/flippers, cream face and belly, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Keep the background plain white, keep all limbs and props intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, text, logos, symbols or watermark. Create one modest completion gesture: a gentle happy nod, brief soft eye-close and one small friendly flipper wave, then settle into a neutral standing pose with eyes open. No repeated waving, jumping or confetti.
```

## 来源与校验

- 视频来源：2026-10-27 由 MiniMax `MiniMax-Hailuo-2.3` 图生视频生成；task_id `456850532958812`，file_id `456850863387234`，SHA256 `b6c8a924bd8f0bf094a6e0c25ad24d65703216226e8b422d24824e54706ae1a5`。
- 技术校验：768x768、24fps、141 帧、5.875 秒、H.264、无音轨。
- 视觉初检：点头、闭眼微笑、单次挥手和回位清晰，无跳动或彩带；循环外的单次动作可读。仍待用户确认最终观感。
