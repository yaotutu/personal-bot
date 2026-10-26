# working 工作

[返回素材总览](../../../avatar.md)

![working 新版候选](working-v2.png)

- 中文动作名：工作。
- phase/status 依据：`executing_tool`、`waiting_subagents`、`finalizing`。
- 动作：斜侧面视角，身体前倾、低头看屏幕，双翅分开并交替抬起敲键；至少两轮清楚可见的打字，不是只有呼吸或全身晃动。
- 输出比例：正方形 `1:1`，视频文件的像素宽高必须相等；不是横版或竖版。
- 播放方式：循环。
- 新参考图：`working-v2.png`（本目录），状态辨识新版候选，待用户确认。
- 确认新版后上传 `working-v2.png`，新视频放本目录，命名 `working-gemini-v2.mp4`；尚未生成。
- [旧版参考](working.png)保留作旧视频来源，不作为新版上传图。
- 旧视频：[working-hailuo-768p.mp4](working-hailuo-768p.mp4)，用户反馈状态不清楚，保留来源记录，不算新版完成。

## 来源与校验

- 旧 Hailuo 视频来源图：`working.png`（不是 `working-v2.png`）；task_id `456403763646900`；file_id `456404482396435`；SHA256 `4f1a78a6a08ac436b4fc4f5d23275aca3a63dac639161f91c3d060ba21293437`。

## 新版制作状态

先看新版参考图是否无需文字也能读出状态，再生成视频。下方提示词针对新版候选；本轮没有生成或验证新版视频。

## 视频提示词

用于基于新版参考图重做视频；不要覆盖旧视频，上传图片与新文件名见上方说明。

```text
Required output format: a true square 1:1 video canvas with equal pixel width and height. The actual file must be square, not landscape 16:9 or portrait 9:16, with no letterboxing, pillarboxing, black bars or borders. Keep the full penguin, crown feathers, feet, flippers and all props inside the frame throughout.

Use working-v2.png as the exact first frame and identity reference. Preserve the ice-blue fluffy penguin, its three-quarter seated view, forward-leaning torso, lowered focused gaze, separated flippers and visible keyboard. Keep the classic silver MacBook Pro rigid, with its white Apple logo steadily glowing. This state is BUSY WORKING, not talking to the viewer or passively watching a screen. Animate a clear repeating WORK CYCLE: perform at least four alternating keyboard presses, visibly lifting one flipper off the keys before pressing while the other changes position; pause briefly with the eyes scanning the screen; then perform another distinct typing burst and return naturally to the initial mid-typing pose for a loop. Keep both keyboard contact and flipper separation readable. Each stroke must visibly change the flipper silhouette, not merely wiggle a feather or bob the whole image. Head and upper body follow the typing with a controlled forward engagement, not a rocking idle loop. Keep eyes on the work, beak closed and expression concentrated rather than angry; do not look up, smile, wave to the viewer or stop typing for most of the clip. Preserve two flippers without fingers. Static camera, plain white background, no motion blur, audio, speech, captions, floating icons, new props, extra limbs, morphing or laptop deformation.
```

## 新版参考图来源与重做提示词

2026-10-26 由内置 image_gen 生成，角色参考为 `../responding/responding.png + working.png`。输出 `working-v2.png`，1254x1254 PNG RGBA，SHA256 `cdaf24efe3fadf19291aae70cf57b072b8be0b0dd7ef010cbe3f69e09cdc3dce`。已由 Agent 查看原尺寸和 96x96 缩略图中的构图与状态线索；这不是用户盲测，用户尚未认可。下方为复用的生图说明，不是视频提示词。

```text
Create a square 1:1 transparent full-body WORKING keyframe. Use the responding penguin image for the existing ice-blue character identity and realistic classic silver MacBook Pro with a glowing white Apple logo; use the old working image only as a comparison, not its quiet frontal pose. Show a decisive three-quarter seated view, torso leaning forward, head lowered and gaze fixed on keyboard or screen, closed neutral beak and focused rather than angry expression. Make both flippers distinct: one raised above the keys mid-press and the other touching a different part of the visible keyboard. Keep the laptop stable across the lap, precision aluminium edges, black keyboard and side ports. Do not look at or smile toward the viewer. No floating gears, badges, speed lines, motion blur, words, clothing, extra props or limbs. Keep every feather, foot, flipper and the laptop inside the square with safe margins, soft studio light and a true transparent background.
```
