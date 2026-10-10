# OpenMuse 客户端兼容补丁

personal-bot 复用 OpenMuse 客户端（Expo Web/iOS/Android）。为方便跟随上游更新，
对 OpenMuse 的改动压缩到**两个文件、约 60 行**，并以 patch 形式在这里维护；
上游更新后在新基线上重新应用即可。

## 当前补丁内容（minimal-client.patch）

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `packages/domain/src/index.ts` | +4 行：workspace runtime 增加可选 `serverOwnedHistory` / `textOnly` 字段 | 能力协商类型。服务端不返回时客户端行为与上游完全一致 |
| `apps/mobile/src/chat.tsx` | ~55 行：读取 `serverOwnedHistory` 并在首次加载与每轮结束后以 `GET /api/conversation` 为准；注册 `currentTime` 工具卡片渲染 | 历史所有权协商（服务端是权威历史源）；工具卡片的 UI 渲染必须在客户端（CopilotKit `useRenderTool` 机制），无法移到服务端 |

不改动 OpenMuse 其它任何文件。富功能入口（底部导航、附件、建议按钮等）保持上游
原版行为：personal-bot 未实现的能力在这些入口里显示为空数据或离线状态，不做伪装。

## 应用方式

```sh
cd /path/to/openmuse
git apply /path/to/personal-bot/compat/openmuse/minimal-client.patch
```

上游更新后如 patch 冲突，用 `git apply -3`（需补丁基于的 blob 可达）或手工重放上述
两处改动。补丁基于的 OpenMuse commit 见 `BASE_COMMIT`。

## 原则

- 服务端（personal-bot）暴露标准 AG-UI 协议 + OpenMuse 快照接口形状，自成一体；
  未来自研客户端直接对接 AG-UI runtime，不依赖本补丁。
- 客户端只做两类最小改动：能力协商读取、工具卡片渲染。新增工具时在卡片注册处
  增加对应 `useRenderTool` 即可。
