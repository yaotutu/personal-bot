# error 失败

[返回素材总览](../../../avatar.md)

![error 失败](error.png)

- 中文动作名：失败。
- phase/status 依据：`status=failed`。
- 动作：扶额、垂肩、低头，持红底白叉失败标记；一次明显摇头后保持失败姿态。
- 输出比例：正方形 `1:1`，视频文件的像素宽高必须相等；不是横版或竖版。
- 播放方式：单次反应，最后保留失败姿态；后续何时回待机由实现侧决定。
- 上传图片：`error.png`（本目录）。
- 视频尚未生成；目标文件名 `error-gemini-v1.mp4`（本目录）。

## 视频提示词

用于生成该动作视频；上传图片见上方说明，下载后按目标文件名放回本目录。

```text
Required output format: a true square 1:1 video canvas with equal pixel width and height. The actual file must be square, not landscape 16:9 or portrait 9:16, with no letterboxing, pillarboxing, black bars or borders. Keep the full penguin, crown feathers, feet, flippers and all props inside the frame throughout.

Use error.png as the exact first frame and identity reference. Preserve the pale ice-blue fluffy penguin, cream face and belly, peach-orange beak and feet, worried half-closed eyes, slumped shoulders, facepalm pose and coral-red badge with its large white X. This is a TASK FAILED reaction, not thinking, greeting, idle or a request for approval. Make one clearly readable non-looping reaction with three beats: first hold the failed facepalm pose long enough to read; then visibly lower the head and shoulders and make one slow side-to-side head shake while the forehead flipper stays in contact; finally settle back into the disappointed facepalm and HOLD the final failed pose. The other flipper keeps the red badge facing the viewer throughout. The flipper must not become a hand with fingers. Do not resume work, smile, wave, shrug cheerfully or reset to a happy neutral pose. Preserve the existing white X; do not remove it under a generic no-symbols instruction. Make the head shake and shoulder drop clearly perceptible at thumbnail size, not just blinking or breathing. Static camera and plain white background; no zoom, cuts, audio, speech, captions, additional symbols, extra limbs, morphing or new props.
```

## 当前图片来源与重做提示词

2026-10-26 由内置 image_gen 生成，输出当前 `error.png`，1254x1254 PNG RGBA，SHA256 `354631c462dded209dace185bb17e9da237cf445ecf4bf11814abf40b30b0791`。已由 Agent 查看原尺寸和 96x96 缩略图中的构图与状态线索；这不是用户盲测，用户尚未认可。下方为复用的生图说明，不是视频提示词。

```text
Create a square 1:1 transparent full-body keyframe using the existing ice-blue penguin only as the character identity reference. Replace the shrug with an unmistakable failed-task reaction: head bowed, shoulders slumped, one flipper pressed to the forehead in a facepalm, worried lowered eyes and a small downturned open beak. The other flipper holds a coral-red circular badge with one large clean white X facing the viewer. Communicate failure through both body posture and badge, not the badge alone. Preserve the pastel fluffy penguin, cream face and belly, pink blush, peach-orange beak and feet and crown feathers. Cute and apologetic, not cheerful, crying or panicking. No laptop, words, extra props, extra limbs or borders; full character visible with safe margins, soft studio light and true transparent fur edges.
```
