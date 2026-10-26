# responding 回复

[返回素材总览](../../../avatar.md)

![responding 回复](responding.png)

- 中文动作名：回复。
- phase/status 依据：`responding`。
- 动作：坐姿轻敲电脑并短暂看向用户；与专注工作的动作保持区别。
- 输出比例：正方形 `1:1`，视频文件的像素宽高必须相等；不是横版或竖版。
- 播放方式：循环。
- 上传图片：`responding.png`（本目录）；当前图待用户反馈。
- 视频尚未生成；目标文件名 `responding-gemini-v1.mp4`（本目录）。

## 来源与校验

- 静态图来源：2026-10-26 用内置 image_gen 对既有回复关键帧做精确对象替换，1254x1254 PNG RGBA，SHA256 `9edfb768cedcdd5b0b378c13179fe80da4de790880d06c9855415ebe949e214e`。
- 旧深色标志版本被用户拒绝；修订版由 Agent 视觉检查，用户仍待反馈。
- 电脑要求：仅将电脑替换为写实经典银色 Retina MacBook Pro（2012-2015 设计），保留冰蓝企鹅与构图；中央白色 Apple 标志和叶片须从内部持续发亮并带柔和光晕，不能变成深色印刷标志、闪烁、脉冲或霓虹描边。

## 当前生图提示词

用于后续重做 `responding.png`；已补充正方形输出约束，现有图片未重新生成：

```text
Required output format: a true square 1:1 image canvas with equal pixel width and height. Do not produce a landscape or portrait image, or place square content inside a rectangular frame. Keep the entire penguin and laptop visible with safe margins, no cropped limbs or props, no borders, and preserve the transparent background.

Replace only the laptop with a photorealistic classic silver Retina MacBook Pro of the 2012-2015 design. Use finely bead-blasted aluminium, machined edges, realistic seams, ports, hinge and black chiclet keyboard. The centred bitten Apple logo and separate leaf must glow bright white from within, with restrained soft bloom on the silver lid, not a dark printed logo or neon outline. Preserve the ice-blue fluffy baby penguin, cream face and belly, pink cheeks, dark eyes, peach-orange beak and feet, crown tufts, seated pose, head tilt, smile, flipper at keyboard, framing and true transparent background. Keep one laptop on the lap, no extra objects, lettering or watermark.
```

## 视频提示词

用于生成该动作视频；上传图片见上方说明，下载后按目标文件名放回本目录。

```text
Required output format: a true square 1:1 video canvas with equal pixel width and height. The actual video file must be square, not a landscape 16:9 or portrait 9:16 video. Do not place square content inside a rectangular frame; no letterboxing, pillarboxing, black bars or borders. Compose directly for the square canvas and keep the entire penguin, crown tuft, feet and any laptop fully visible throughout the motion, with safe margins and no cropped limbs or props.

Use the uploaded image as the exact first frame and preserve the character identity and composition: pale ice-blue head/back/flippers, cream face and belly, pink blush cheeks, small dark glossy eyes, peach-orange beak and feet, crown tuft, fine soft down, light palette, proportions and camera framing. Keep the photorealistic classic silver Retina MacBook Pro from the reference unchanged, including its aluminium texture, machined edges, side ports, keyboard, proportions and position on the penguin's lap. Its centred white Apple logo must remain lit from within with steady brightness and a subtle soft halo throughout; never replace it with a dark logo, make it flicker or pulse, or turn it off. Keep a completely static eye-level camera: no pan, zoom, shake, cuts, reframing or whole-image pulsing. Move only the character with small coherent head, eyelid, flipper and body motion. Render the transparent background as plain white, keep all limbs and the MacBook Pro intact, and keep the full character inside the frame. No audio, speech, morphing, extra limbs, new clothing, watermark or extra objects. The seated penguin lightly types on the MacBook Pro with alternating short flipper movements, briefly looks up toward the viewer with an engaged smile, then returns to the starting pose. Keep the MacBook Pro rigid and do not add speech or lip sync. Return naturally to the starting pose so the action can loop.
```
