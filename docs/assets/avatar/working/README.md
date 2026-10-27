# working 工作

[返回素材总览](../../../avatar.md)

![working 工作](working.png)

- 中文动作名：工作。
- phase/status 依据：`executing_tool`、`waiting_subagents`、`finalizing`。
- 动作：斜侧面视角，身体前倾、低头看屏幕，双翅分开并交替抬起敲键；至少两轮清楚可见的打字。
- 输出比例：正方形 `1:1`，视频文件的像素宽高必须相等；不是横版或竖版。
- 播放方式：循环。
- 上传图片：`working.png`（本目录）。
- 视频尚未生成；目标文件名 `working-gemini-v1.mp4`（本目录）。

## 视频提示词

用于生成该动作视频；上传图片见上方说明，下载后按目标文件名放回本目录。

```text
Required output format: a true square 1:1 video canvas with equal pixel width and height. The actual file must be square, not landscape 16:9 or portrait 9:16, with no letterboxing, pillarboxing, black bars or borders. Keep the full penguin, crown feathers, feet, flippers and all props inside the frame throughout.

Use working.png as the exact first frame and identity reference. Preserve the ice-blue fluffy penguin, its three-quarter seated view, forward-leaning torso, lowered focused gaze, separated flippers and visible keyboard. Keep the classic silver MacBook Pro rigid, with its white Apple logo steadily glowing. This state is BUSY WORKING, not talking to the viewer or passively watching a screen. Animate a clear repeating WORK CYCLE: perform at least four alternating keyboard presses, visibly lifting one flipper off the keys before pressing while the other changes position; pause briefly with the eyes scanning the screen; then perform another distinct typing burst and return naturally to the initial mid-typing pose for a loop. Keep both keyboard contact and flipper separation readable. Each stroke must visibly change the flipper silhouette, not merely wiggle a feather or bob the whole image. Head and upper body follow the typing with a controlled forward engagement, not a rocking idle loop. Keep eyes on the work, beak closed and expression concentrated rather than angry; do not look up, smile, wave to the viewer or stop typing for most of the clip. Preserve two flippers without fingers. Static camera, plain white background, no motion blur, audio, speech, captions, floating icons, new props, extra limbs, morphing or laptop deformation.
```

## 当前图片来源与重做提示词

2026-10-26 由内置 image_gen 生成，角色与电脑参考为 `../responding/responding.png`。输出当前 `working.png`，1254x1254 PNG RGBA，SHA256 `cdaf24efe3fadf19291aae70cf57b072b8be0b0dd7ef010cbe3f69e09cdc3dce`。已由 Agent 查看原尺寸和 96x96 缩略图中的构图与状态线索；这不是用户盲测，用户尚未认可。下方为复用的生图说明，不是视频提示词。

```text
Create a square 1:1 transparent full-body WORKING keyframe. Use the responding penguin image for the existing ice-blue character identity and realistic classic silver MacBook Pro with a glowing white Apple logo. Show a decisive three-quarter seated view, torso leaning forward, head lowered and gaze fixed on keyboard or screen, closed neutral beak and focused rather than angry expression. Make both flippers distinct: one raised above the keys mid-press and the other touching a different part of the visible keyboard. Keep the laptop stable across the lap, precision aluminium edges, black keyboard and side ports. Do not look at or smile toward the viewer. No floating gears, badges, speed lines, motion blur, words, clothing, extra props or limbs. Keep every feather, foot, flipper and the laptop inside the square with safe margins, soft studio light and a true transparent background.
```
