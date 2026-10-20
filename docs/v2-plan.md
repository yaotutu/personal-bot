# Personal Bot v2 方案：对齐 OpenMuse 服务端（pi 内核）

> **历史方案，不再作为当前实施入口。** 下文保留 2026-10-11 讨论原文，其中的 PGlite、src-v2、worker 队列、CopilotRuntime、连接器桩及“只做服务端验收”等选择不代表当前实现，也不是继续实施的授权。当前方向与安全/交付规则见 [AGENTS.md](../AGENTS.md)及 [架构规范](architecture.md)，未实施需求见 [backlog](backlog.md)。

> 状态：方案讨论稿（2026-10-11）。产品定位已变更：从"复刻 nanobot 聊天助手"转向
> **自托管的 OpenMuse 服务端完整实现，agent 内核用 pi**。v1（src/）保留可跑，v2 渐进替换。

## 0. 已确认的方向决策与执行原则

| 决策 | 结论 |
| --- | --- |
| 产品定位 | **OpenMuse 式工作台形态**（多会话 + tasks/goals/monitors/审批），域模型借鉴它的成熟设计 |
| 客户端兼容 | **不要求 100% 兼容 OpenMuse 客户端**——API 自主设计，借鉴域模型但形状自定；用户将自研客户端 |
| 连接器 | 外部浏览器/云桌面/Gmail 等**先不做**（不实现也不急做桩），将来一个功能一个功能叠加 |
| 存储 | PGlite（内嵌 Postgres，owner/kind/id 记录表，借鉴上游 db.ts 设计） |
| 代码库 | 同仓 v2 目录渐进替换（src-v2/ → 验收后替换 src/） |

**执行原则（用户原话精神）**：
1. 先把全部东西**串起来、顺起来**——主线跑通优先于功能完备。
2. 功能一个一个叠加，每个都独立可跑、可测；边缘功能（浏览器/电脑/邮箱）靠后或不做。
3. 只做服务端，不关心客户端验证；验收 = 服务端 API 正确（集成测试），非页面点亮。
4. AG-UI runtime 保留（标准协议，现成/自研客户端皆可用），但核心 API 不迁就其形状。

## 1. 对齐目标的全貌（OpenMuse 服务端实测 ~8400 行）

**实现**（骨架，~5000 行等价物）：
- `engine/`：AgentService（tasks 生命周期 create/control:pause|resume|cancel|retry/answer、
  goals+milestones、monitors、ideas、快照聚合）+ worker 执行循环 + 会话引擎 + TanStack agent 编排
- `db.ts`：PGlite/Postgres，records(owner/kind/id, JSON data)
- `workspace.ts`/`app.ts`：快照与 20+ 组路由、actions 审批流、files、search、限流
- 多会话 threads（客户端 richThreads 模式）

**桩**（连接器，~3500 行不做真实现）：
- computer/E2B 云桌面、browser、google-auth、mail、calendars——返回未配置空态
- jev（对话引导）与 finance：定位变更后非核心，先桩后评估

## 2. v2 架构

```
HTTP (Hono)
 ├─ OpenMuse API 形状：workspace / agent(+7 子域) / conversation /
 │   actions / files / search / threads / 连接器桩
 └─ AG-UI runtime：每 thread 一个 agent（CopilotRuntime agents 工厂）
域层
 ├─ AgentService：tasks / goals / monitors / ideas / notifications / actions(审批)
 ├─ worker：单进程并发池（上限 2），pause/resume/cancel/retry → pi abort + 状态
 └─ 连接器桩：connected:false 形状（对照上游未登录响应）
内核适配（从 v1 平移 ~70%）
 ├─ pi session 工厂：每 task/thread 独立 session 与 agent 目录
 ├─ 工具注册 + allowlist + guardTool 边界 + SOUL/USER/记忆注入 + 压缩参数
 └─ plan/evidence 投影：pi 工具事件流 → AgentTask.plan/evidence
存储
 └─ PGlite records 表（owner/kind/id JSON），单文件 data.db，权限 600
```

### 关键映射决策

1. **task 执行 = 一次 pi run**：createTask → worker 领取 → 独立 pi session 跑 prompt →
   plan（模型工具序列）与 evidence（文件/搜索产物）从事件流投影 → result 落库。
   上游 tanstack-agent.ts(242 行) 的位置由 pi 装配顶替。
2. **聊天与任务统一**：threads 即多会话；聊天轮 = 无 task 的直接 run；聊天内 delegate
   （客户端现成 API）创建 task 异步执行，结果回聊天流通知。
3. **actions 审批 = 工具前置闸**：写类工具（未来的 edit/write、外发动作）调用前挂起
   生成 action 记录，/api/actions decide 放行/拒绝——接上 v1 远期的"写文件+审批"。
4. **monitors = v1 jobs 泛化**：interval 调度骨架平移，"变化才通知"（page-diff 思路）后续加。
5. **AG-UI 投影逻辑平移**：v1 conversation.ts 的 toolcall/AG-UI 事件映射、脱敏、
   history 投影规则原样泛化到多 thread。

## 3. 实施路线（每阶段测试全绿 + Web 页面验收）

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| V0 地基 | src-v2/ 脚手架、PGlite store、配置/鉴权/限流平移、快照路由接真实域数据、测试框架移植 | 2-3 天 |
| V1 threads | threads CRUD、每 thread pi session、AG-UI 多 agent、聊天逻辑泛化迁移 | 3-4 天 |
| V2 tasks+worker | AgentTask 域、create/control/answer、并发 worker、plan/evidence 投影、actions 审批 | 4-5 天 |
| V3 goals/monitors | goals/milestones/ideas CRUD、monitors 调度（v1 jobs 平移）、通知流 | 2-3 天 |
| V4 收尾 | 连接器桩、全页面 Web 验收（目标：客户端零 patch 或仅剩历史协商）、文档与切换 | 2-3 天 |

合计 **3-4 周**。v1 保持可跑直到 V4 验收后一次性切换。

## 4. 风险与对策

1. **API 契约细节**：20+ 组路由的响应形状必须逐个对照上游源码/抓包——先写契约测试
   （fixture 来自上游服务端的真实响应），避免"形状差一点客户端就崩"。
2. **多 pi session 并发**：v1 openPi 是单例模式，需参数化（独立 agent 目录、独立资源）；
   并发上限先固定 2，避免网关限流。
3. **worker 与聊天并发**：共用模型网关；单用户场景冲突概率低，worker 让位聊天（空闲才跑）。
4. **上游漂移**：对齐基线 = OpenMuse HEAD `1ac68f3`；上游更新按 compat patch 同样思路跟随。
5. **PGlite 依赖**：跟随上游选择；若遇 node 24 兼容问题，退路是同语义 JSON store（接口不变）。

## 5. v1 → v2 可平移资产清单

- `src/pi.ts` 工具注册/allowlist/guardTool/注入/压缩参数（~90% 平移）
- `src/memory.ts`（改存 PGlite，接口不变）、`src/jobs.ts` 调度计算
- AG-UI 事件映射 + 脱敏 + 历史投影规则（conversation.ts 核心逻辑泛化）
- `tests/fake-model.ts` 触发词体系与全部测试模式
- 安全边界设计（key/路径/脱敏/单进程）与 AGENTS.md 哲学条目
