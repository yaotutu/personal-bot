# 前端接口改造与迁移说明：空间（Space）与会话（Session）解耦及重置机制

> **面向前端 / 客户端开发者的接入与改造指南。**
> 本文梳理了服务端关于「空间（Space）」与「会话（Session）」解耦的底层概念、接口路径重构（`/api/threads/*` -> `/api/spaces/*`）、新增重置会话端点，以及字段映射和交互建议。
> 接口精确契约以运行时 `/docs` 和 `/openapi.json` 为准。

---

## 1. 核心概念与架构演进

在早期版本中，会话（Thread / Session）是一个混合概念：它既代表用户对话的场景和上下文配置，又直接绑定底层的单条聊天历史文件。随着场景的深入，这带来了以下问题：
1. 聊天历史变长或出现异常时，无法单独“换新会话”，必须把整个场景连同配置、文件一并销毁。
2. 定时任务、专属规则、技能配置等到底是属于“会话”还是属于“场景”不清晰。

本次重构确立了两层解耦模型：

- **空间（Space / `spaceId`）**：
  - **上层业务与场景容器**。例如：默认主空间 `local-main`、旅行规划空间 `trip-2026`、代码辅助空间 `code-helper` 等。
  - 空间拥有**专属指令规则（`INSTRUCTIONS.md`）**、**技能开关配置（`skills.json`）**、**Dream 记忆整理配置（`DREAM.md` / `dream.json`）**以及**私有隔离工作区（`workspace/threads/:spaceId`）**。
  - 空间生命周期由用户主动删除（`DELETE /api/spaces/:spaceId`）才会彻底清理。
- **会话（Session / `sessionId`）**：
  - **空间下挂载的交互实体**，由独立 UUID 标识（对应底层 `.jsonl` 存储）。
  - 一个空间在同一时刻挂载一个活跃的会话。
- **重置机制（Reset）**：
  - 当空间内的上下文过长或需要翻篇时，对该空间执行**重置（Reset）**。
  - 重置会为该空间生成一个全新的 `sessionId`，并清空旧聊天历史文件，但**完整保留空间本身、私有工作区文件、INSTRUCTIONS 专属规则与技能配置**。
  - 空间下挂载的定时任务与网页监控默认保留，并自动绑定到新会话；同时提供可选选项供用户在重置时一并级联清理。

---

## 2. 接口路径迁移一览表

原有所有 `/api/threads/*` 端点已整体重构迁移至 `/api/spaces/*`，并新增重置端点：

| 功能模块 | 旧接口路径（已废弃） | 新接口路径 | 请求方法 | 备注说明 |
| :--- | :--- | :--- | :--- | :--- |
| **空间列表** | `GET /api/threads` | `GET /api/spaces` | GET | 返回 `{ spaces: SpaceSnapshot[] }` |
| **重置空间会话** | *(无)* | `POST /api/spaces/:spaceId/reset` | POST | 支持选择是否级联清理定时任务/监控 |
| **读取技能状态** | `GET /api/threads/:id/skills` | `GET /api/spaces/:spaceId/skills` | GET | 返回该空间技能生效值与覆盖 |
| **保存技能覆盖** | `PUT /api/threads/:id/skills` | `PUT /api/spaces/:spaceId/skills` | PUT | 保存该空间的技能开关 |
| **读取专属指令** | `GET /api/threads/:id/instructions` | `GET /api/spaces/:spaceId/instructions` | GET | 读取 `INSTRUCTIONS.md` |
| **保存专属指令** | `PUT /api/threads/:id/instructions` | `PUT /api/spaces/:spaceId/instructions` | PUT | 保存专属指令，可附带 `purpose` 空间用途 |
| **读取 Dream 状态** | `GET /api/threads/:id/dream` | `GET /api/spaces/:spaceId/dream` | GET | 读取该空间的后台整理状态与待决项 |
| **保存 Dream 配置** | `PUT /api/threads/:id/dream` | `PUT /api/spaces/:spaceId/dream` | PUT | 保存该空间 Dream 开关与专属提示词 |
| **立即执行 Dream** | `POST /api/threads/:id/dream/run` | `POST /api/spaces/:spaceId/dream/run` | POST | 立即整理该空间未读消息 |
| **处理 Dream 建议** | `POST /api/threads/:id/dream/pending/:pendingId` | `POST /api/spaces/:spaceId/dream/pending/:pendingId` | POST | 应用或忽略建议（入库 USER/SOUL/空间规则/MEMORY） |
| **删除空间** | `DELETE /api/threads/:id` | `DELETE /api/spaces/:spaceId` | DELETE | 彻底删除空间、会话历史、工作区及关联任务 |

---

## 3. 详细报文与契约说明

### 3.1 空间列表 (`GET /api/spaces`)

**响应示例：**
```json
{
  "spaces": [
    {
      "id": "local-main",
      "sessionId": "6f2d590e-b816-419b-a083-d51ef5847e09",
      "updatedAt": "2026-10-20T09:15:00.000Z"
    },
    {
      "id": "trip-planner",
      "sessionId": "d04e38e1-512c-48be-8f85-1d4cb8008a91",
      "updatedAt": "2026-10-20T08:30:00.000Z"
    }
  ]
}
```
- `id`: 空间 ID（主空间固定为 `local-main`）。
- `sessionId`: 该空间当前挂载生效的会话 ID。
- `updatedAt`: 该空间当前会话历史最近更新的 ISO 8601 时间。

---

### 3.2 重置空间当前会话 (`POST /api/spaces/:spaceId/reset`)

用于开启全新会话，解决会话过长、上下文紊乱或出错等问题。

**请求体 (`ResetSpaceSchema`)：**
```json
{
  "clearSchedules": false
}
```
- `clearSchedules`（可选，布尔值，默认 `false`）：
  - `false`（推荐默认）：**保留**该空间下的定时任务与网页监控，重置后任务继续有效并自动投递到新会话。
  - `true`：重置的同时**级联删除**归属于该空间的所有定时任务与网页监控。

**响应体 (`ResetSpaceResponse`)：**
```json
{
  "ok": true,
  "spaceId": "trip-planner",
  "sessionId": "a189f412-f720-410a-8bf8-07cb15cf0da3",
  "cancelledApprovals": 1,
  "removed": {
    "jobs": 0,
    "monitors": 0
  }
}
```
- `spaceId`: 被重置的空间 ID。
- `sessionId`: 重置后生成的全新会话 ID。
- `cancelledApprovals`: 因重置而自动作废的未决审批写操作数（包含关闭活跃运行期间被级联取消的审批，即重置发生时所有从 `pending` 变为 `cancelled` 的审批总数）。
- `removed.jobs` / `removed.monitors`: 被级联清理的任务和监控数（当 `clearSchedules=true` 时大于 0）。

**重置内部行为：**
1. 立即中断并关闭当前空间内活跃的协调器与模型运行；
2. 清空当前空间 `sessions/:spaceId/` 目录下的 `.jsonl` 历史文件；
3. 保留并继承 `skills.json`、`INSTRUCTIONS.md`、`DREAM.md` 和私有工作区目录；
4. 重置该空间的 Dream 整理游标与待决建议；
5. 自动作废当前空间残留的待审批（`pending` 状态的审批变更为 `cancelled`）；
6. 重新以全新 `sessionId` 开启该空间，前端随即可请求空历史并开始新对话。

---

### 3.3 聊天与执行端点

- **发送消息 (`POST /api/conversation/run`)**：
  - 请求体字段由原 `threadId` 变更为 `spaceId`（后端已实现平滑兼容，传入 `threadId` 仍可正常识别）。
  - 示例：
    ```json
    {
      "spaceId": "local-main",
      "expectedRevision": "...",
      "message": { "id": "msg-1", "content": "你好" },
      "runId": "run-uuid"
    }
    ```
- **读取聊天历史 (`GET /api/conversation?spaceId=...`)**：
  - 推荐传入 `?spaceId=local-main`（兼容保留 `?threadId=`）。
- **中止运行 (`POST /api/conversation/stop`)**：
  - 请求体推荐字段：`{ "spaceId": "local-main", "runId": "..." }`（兼容保留 `threadId`）。

---

### 3.4 运行状态与活动端点

- **查询运行状态 (`GET /api/agent/status`)**：
  - Query 参数由 `threadId` 变更为 `spaceId`（兼容 `threadId`）。
  - 示例：`GET /api/agent/status?spaceId=local-main&runId=...`
  - 响应中的运行对象属性：
    - `spaceId`: 空间 ID。
    - `threadId`: 兼容字段，值与 `spaceId` 严格相同。
- **活动列表查询 (`GET /api/activities`)**：
  - Query 过滤参数支持 `?spaceId=...`（兼容 `?threadId=...`）。
  - 活动对象中同时返回 `spaceId` 和兼容字段 `threadId`。

---

### 3.5 审批与工作区事件（SSE）

- **审批对象 (`ApprovalViewDto`)**：
  - 顶层字段：`spaceId` 与 `workspaceSpaceId` 为主要字段，同时附带兼容字段 `threadId` 与 `workspaceThreadId`。
  - 文件预览 (`preview`)：
    - `preview.scope`: 枚举支持 `"space"` | `"thread"` | `"shared"`。前端建议将 `"space"` 与 `"thread"` 均展示为「空间私有工作区」。
    - `preview.ownerSpaceId`: 归属空间 ID（同时附带兼容字段 `ownerThreadId`）。
- **SSE 事件 (`/api/events`)**：
  - `ready` 帧中的 `agentStatuses` 与增量帧 `agent_status_updated` 中均包含 `spaceId`。
  - `ready.pendingApprovals` 与 `approval_pending` 中完整携带上述空间预览字段。

---

## 4. 前端交互推荐实现方案

### 4.1 会话头部操作区

建议在聊天窗口右上角操作区（如在模型选择、设置旁）增加「**重置当前会话**」按钮：
1. 点击重置按钮时，弹出二次确认模态弹窗（Modal / Dialog）。
2. 弹窗提示文案示例：
   > **重置当前会话？**
   > 重置将开启全新对话，清空当前聊天历史与未完成的审批；但空间规则（Instructions）、技能开关和已保存的工作区文件都会保留。
3. 弹窗内提供复选框（Checkbox）：
   - `[ ] 同时清理此空间下的定时任务与网页监控`（默认不勾选）。
4. 用户确认后调用：
   ```ts
   await resetSpace(currentSpaceId, { clearSchedules: isChecked });
   ```
5. 重置成功后：
   - 清空前端当前会话的消息列表展示；
   - 刷新空间列表以获取最新的 `sessionId` 与 `updatedAt`；
   - 提示用户“会话已重置，可开启全新对话”。

### 4.2 空间切换与管理

- 侧边栏/导航栏中的会话列表标题建议统一更新为「**空间**」或「**频道**」。
- 点击创建时提示「新建空间」；删除空间时提示「删除空间将彻底清除该空间所有历史记录、文件与任务，不可恢复」。
