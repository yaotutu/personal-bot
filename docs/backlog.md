# 待实施需求池

这里统一记录已经讨论、但尚未实施的需求。当前实现以源码为准，验收结论以实际执行结果及对应版本报告为准；本文件不是“已经支持”的功能清单。

> 编号规则：REQ-001 至 REQ-010 为旧批次编号，已完成/合并的条目保留编号占用、不回收复用，以便历史讨论记录中的引用仍可对应。新需求从 REQ-012 起继续编号。

## 使用约定

- **讨论不等于开工**。用户认可方案，也不代表立即授权实施；明确要求“先记录、晚点做”的需求保持待实施。
- 后续讨论形成新需求时，先在这里登记；较详细的方案放 `docs/discussions/`，本页保留入口与状态。
- 区分“讨论中”和“方案认可、暂缓实施”，不要把助手建议记成用户定论。
- 开始实施、变更范围或完成验收时更新状态；**完成后移出待实施清单**，在下方“已完成”一节留编号、一句话结论与验收记录链接，需要保留的版本验收记录放 `docs/archive/`，不另建交接文档。
- 不因为登记需求自动创建定时任务、启动后台处理或修改正式数据。

## 已完成

以下需求已实施验收并移出待实施清单；编号保留占用，历史讨论中的引用仍可对应。当前行为以源码、运行时 `/docs` 与 `/openapi.json` 为准。

### REQ-005 · 完整浏览器能力（用户可操作 + Agent 可操作）—— 已完成（V1）

- **完成日期：** 2026-10-25。
- **实施结果：** 服务端提供独立真实浏览器域：系统 Chrome 懒启动、持久 profile、全局标签管理、当前标签 CDP JPEG 帧流、基础输入、`/browser` 调试页，以及与用户共享同一实例的 `navigate` / `snapshot` / `act` / `tab` Agent 工具。移动客户端集成本次明确不在范围内。
- **验收记录：** [浏览器 V1 验收记录](archive/req-005-browser-v1.md)。

### REQ-009 · 长期记忆独立查询与管理接口 —— 已完成

- **完成日期：** 2026-10-21。
- **实施结果：** 提升为独立顶层资源 `/api/memories`（GET 列表与检索支持 q 忽略大小写子串搜索、limit 限制条数、sort 支持 updatedAt/createdAt、order 支持 asc/desc，上限 500 条全量返回不分页；GET /:id 单条详情；POST 创建记忆，500 条满额时 409；PATCH /:id 更新记忆内容并自动推进 updatedAt；DELETE /:id 删除记忆返回 `{ ok: true, id }`）。工作区快照 `GET /api/agent` 彻底脱耦并移除 `memories` 字段，彻底移除旧 `/api/agent/memories*` 端点，不作旧字段兼容。

### REQ-010 · 网页监控独立查询与管理接口 —— 已完成

- **完成日期：** 2026-10-21。
- **实施结果：** 独立顶层资源 `/api/monitors`（GET 列表支持 spaceId 过滤与 createdAt/lastCheckedAt/status 排序，全量返回不分页；GET /:id 详情；POST 新建；POST /:id/control 控制 pause/resume/stop；PATCH /:id 修改 title/url/condition/value/intervalMinutes/originSpaceId，若修改 URL 或检测条件/关键词自动重置内容指纹与命中基线；DELETE /:id 彻底删除）。彻底移除旧 `/api/agent/monitors*` 端点及 `GET /api/agent` 快照中的 `monitors` 字段，不作旧字段兼容。

### REQ-007 · 定时任务独立查询与管理接口 —— 已完成

- **完成日期：** 2026-10-20。
- **实施结果：** 独立资源 `/api/jobs`（GET 列表支持 spaceId 过滤与 nextRunAt/updatedAt/createdAt 排序，全量返回不分页；GET /:id 详情；POST /:id/control 控制 pause/resume/cancel/retry；PATCH /:id 修改 prompt/daily/at/originSpaceId 并自动重算 nextRunAt；DELETE /:id 彻底删除）。移除旧 `/api/agent/tasks*` 端点及 `GET /api/agent` 快照中的 `tasks` 字段，不作旧字段兼容。

### REQ-012 · 活动与领域状态的全局 SSE 推送 —— 已完成

- **完成日期：** 2026-10-20。
- **实施结果：** 在 `GET /api/events` 中接入 `activity_updated` 增量事件与 `ready.activities` 全量活跃活动快照；主模型登记、推进、审批等待与完成/中断等生命周期变化实时推送到客户端，无需轮询。

### REQ-011 · 实例配置文件目录统一收拢至 profile/ —— 已完成

- **完成日期：** 2026-10-20。
- **实施结果：** 全局身份、用户画像、Dream 提示词与长期记忆文件统一收拢至 `profile/` 目录（`profile/SOUL.md`、`profile/USER.md`、`profile/DREAM.md`、`profile/memory.json`）；会话目录 `sessions/<spaceId>/` 保持既有隔离与扁平结构（`INSTRUCTIONS.md`、`skills.json`、`DREAM.md`、`dream.json`），数据布局单一权威更新，不进行隐式历史迁移。

### REQ-001 · Dream 后台记忆整理 —— 已完成

- **完成日期：** 2026-10-20。
- **实施结果：** 记忆分层（SOUL/USER/会话指令每轮携带、`memory.json` 按需检索 `memory_search`、500 条硬上限）；全局/会话 `DREAM.md` 可继承；主会话默认开启、其他会话默认关闭；每 2 小时后台整理与手动触发；待确认列表；HTTP 契约与 Web 设置页。
- **方案与验收：** [Dream 后台记忆整理](discussions/dream-memory.md)。

### REQ-002 · 空间重置（保留记忆与工作区）—— 已完成

- **完成日期：** 2026-10-20。
- **实施结果：** 落地为空间/会话解耦后的 `POST /api/spaces/:spaceId/reset`：清空聊天历史、以全新 `sessionId` 重开、作废残留待审批（计数含运行关闭级联取消），保留工作区、`INSTRUCTIONS.md`、技能开关与 Dream 配置；`clearSchedules` 可选级联删除定时任务与监控。同步完成 thread→space 接口重构与前端迁移说明。
- **迁移说明：** [前端空间/会话迁移说明](frontend-space-session-migration.md)。

### REQ-003 · Activity 执行活动 —— 已完成（SSE 推送对接并入 REQ-012）

- **完成日期：** 2026-10-19。
- **实施结果：** 主 Agent 自主登记、完成保护、跨轮继续、真实逐步明细、列表/详情查询（游标分页）。
- **验收记录：** [Activity e2e 验收](archive/2026-10-19-activity-e2e-acceptance.md)；业务规则见 [Activity 执行活动](discussions/activity.md)。
- **遗留：** 与全局 SSE 的状态推送对接随 REQ-012 讨论。

### REQ-004 · 审批决定、执行结果与历史查询 —— 已完成

- **完成日期：** 2026-10-19。
- **实施结果：** `GET /api/approvals`、`GET /api/approvals/pending`、`GET /api/approvals/:id`、`POST /api/approvals/:id/decision`；授权与执行回执分离；历史摘要分页、单项完整详情、完整预览长期保留。
- **业务规则：** [审批接口](discussions/approvals.md)。

### REQ-006 · 全局 SSE 直接推送展示状态 —— 已完成

- **完成日期：** 2026-10-19。
- **实施结果：** `GET /api/events` 的 `ready` / `agent_status_updated` / `approval_pending` / `approval_updated` 与 `GET /api/agent/status`；连接/重连同步当前状态与待审批项，后续直推变化。

### REQ-008 / REQ-013 · 目标（Goals）独立查询与管理接口 —— 已完成

- **完成日期：** 2026-10-21。
- **实施结果：** 提升为独立顶层资源 `/api/goals`（GET 列表支持 status、category 过滤与 updatedAt/createdAt 排序，全量返回不分页；GET /:id 单项详情；POST 创建目标；PATCH /:id 更新属性与 status，设为 completed 时自动勾选名下全部未完成里程碑；POST /:id/milestones/:mid/toggle 切换里程碑完成状态；DELETE /:id 删除目标返回 `{ ok: true, id }`）。工作区快照 `GET /api/agent` 彻底脱耦并移除 `goals` 字段，彻底移除旧 `/api/agent/goals*` 端点，不作旧字段兼容。
