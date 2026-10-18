# 单 Agent、多会话

> **项目：pi-muse**
>
> 状态：下文保留 2026-10-17 的原始讨论；2026-10-18 已推进实现，当前约定以 README、architecture.md 和 HANDOFF.md 为准。
>
> **后续定案优先于下文旧稿：** 每个会话（包括 local-main 与 task-*）的 cwd/文件根固定为
> `workspace/threads/<threadId>/`，共享区为 `workspace/shared/`（用 shared/ 显式访问），
> workspace/ 与 threads/ 只是容器。会话规则位于 `sessions/<id>/INSTRUCTIONS.md`，可通过
> instructions 工具或 GET/PUT instructions 接口修改，下一轮重读。普通文件工具拒绝绝对路径、
> .. 和根/父目录/目标符号链接；仅 read 可精确读取已启用技能的 SKILL.md，不开放技能目录。
> 内置技能随程序从 assets/skills（构建后 dist/assets/skills）读取，不复制到数据目录，
> 用户技能使用数据目录 skills/。不做旧数据迁移或旧 cwd 历史回退，不自动删除原文件。
> 下文“单一工作目录”“只铺一次内置技能”“旧 jobs 兼容”等叙述属于旧方案，不再适用。
>
> 产品形态：**仍然只有一个 Agent**。一个工作目录、一份 `SOUL.md` / `USER.md`、
> 一套 `workspace/`，都是现在这一份，不按会话拆。会话维度上只有三件事：
> 每个会话可选技能、定时任务绑定创建它的会话、主会话不可删而其他会话可删。
> 其余仍走正常的 Agent 运行方式。
>
> 初版「每 agent 一个目录」方案已归档到
> [`docs/archive/multi-agent-per-agent-design.md`](../archive/multi-agent-per-agent-design.md)，
> 仅作历史记录，不是当前实现约定。

## 结论

单 Agent、多会话。没有第二个 Agent，也没有 per-agent 数据。

- **一个全局技能目录** `skills/`，所有会话共享。
- **技能自带默认开关**：`skills/<name>/config.json` 的 `defaultEnabled`，在技能被创建时确定。
- **每个会话只存覆盖**：`sessions/<threadId>/skills.json` 里记「这个会话把哪些技能改成开/关」。

生效值 = 会话覆盖 ?? 技能默认值。技能是**能力包**：关闭 = 从 system prompt 移除说明 +
不装配它自带的工具。会话是唯一的隔离单位：技能、定时任务归属、删除范围都按会话算；
工作目录、SOUL/USER、memory/goals/tasks 等业务数据全部沿用现在的单 Agent 逻辑。

## 数据布局

只新增技能目录与会话覆盖文件，其余一律不动：

```
.pi-muse/
├── config.json / auth.key
├── SOUL.md / USER.md
├── skills/                          ← 新增：全局唯一技能目录
│   ├── cron/
│   │   ├── SKILL.md                 ← 说明（pi 官方格式，frontmatter 需 name + description）
│   │   ├── config.json              ← { "defaultEnabled": true }
│   │   └── extension.ts             ← 可选：技能自带工具（pi 官方 extension）
│   ├── monitor/ goal/ task/ memory/ web/ write/   ← 内置，defaultEnabled=true
│   └── <用户技能>/                    ← 用户放进来，首次扫描自动补 config.json（默认关）
│
├── sessions/<threadId>/
│   ├── <timestamp>_<id>.jsonl       ← pi 历史，不动
│   └── skills.json                  ← 新增：该会话的覆盖 { overrides: { name: bool } }
│
├── memory.json / goals.json / tasks.json / actions.json / monitors.json / jobs.json
├── workspace/
└── agent/
```

`delegate_task` 派生的 subagent 复用同一套结构：它的会话是
`sessions/task-<id>/`，覆盖文件在任务创建时从父会话快照过来（见下）。

这棵树就是**一个 Agent 的全部**：`workspace/` 一个、`sessions/` 一套、
`SOUL.md` / `USER.md` 各一份，没有第二份。`sessions/local-main/` 是主会话目录，
受保护不可删（见「会话生命周期」）。`data-layout.ts` 只加 `skillsDir` 与
`threadSkillsFile(threadId)`。六个 feature repository、scheduler、task worker、
现有 HTTP 契约都不改。

## 技能目录

- **只有一个** `skills/`，所有会话共享；没有 per-agent / per-session 副本。
- 目录名 = 技能名 = frontmatter `name`（pi 校验：小写字母、数字、连字符）。
- 用户在 `skills/` 里新建目录即可；服务端扫描到缺 `config.json` 的技能时自动补写
  `{ "defaultEnabled": false }` 并返回一条诊断。**不提供创建接口**，也没有模板生成。
- 内置 7 项只在 `skills/` 目录**尚不存在**时铺一次（连同 `defaultEnabled: true`）；
  之后用户删掉就是删掉，重启不补。
- 技能自带工具走 **pi 官方 extension**：`skills/<name>/extension.ts`，默认导出
  `(api) => void`，用 `api.registerTool(...)` 注册。我们不解析、不执行自己的脚本格式，
  也不支持 frontmatter 声明工具。
- 技能文件解析失败、extension 加载失败都只记诊断，不影响会话启动，也不影响其他技能。

### 内置 7 项（能力包）

| 技能 | 收纳的内置工具 | defaultEnabled |
|---|---|---|
| `cron` | `schedule` | true |
| `monitor` | `monitor` | true |
| `task` | `delegate_task` | true |
| `goal` | `goal` | true |
| `memory` | `memory` | true |
| `web` | `search_web`、`web_fetch` | true |
| `write` | `write`、`edit` | true |

**始终开启、不参与开关**：`currentTime`、`read`、`grep`、`find`、`ls`、`get_weather`。

- `read` 必须常开：pi 只有在 `read`/`bash` 至少一个在工具集合里时才把 `<skills>`
  段写进 system prompt（两者都不在时整段静默丢弃）；它也是模型打开 SKILL.md 的入口。
- `get_weather` 已有 `tools.weather.enabled` 配置开关，不叠加会话开关。
- `write` 技能只决定工具是否装配；审批闸门、路径边界、符号链接拒绝都不变。

## 三种异步路径的技能来源

避免把「subagent」和「定时任务」混在一起，这里一次说清。三者都不是第二个 Agent，
都复用同一个 pi 运行时、同一份 workspace 与 SOUL/USER。

| 路径 | 工具 / 存储 | 跑在哪个会话 | 技能来源 |
|---|---|---|---|
| **subagent** | `delegate_task` → `tasks.json` → `sessions/task-<id>/` | 独立会话 `task-<id>` | **父会话在提交时的快照** |
| **定时任务** | `schedule` → `jobs.json`（含 `originThreadId`）→ scheduler | **创建它的那个会话** | 该会话**当前**的覆盖 |
| **网页监控** | `monitor` → `monitors.json` → monitor-scheduler | 不起会话 | 不涉及（只抓网页、不跑模型轮） |

### subagent 的继承规则

- 建任务时把父会话的 `sessions/<parent>/skills.json` 复制到
  `sessions/task-<id>/skills.json`；父会话没有覆盖文件就不复制，子任务跟随技能默认值。
- 快照发生在**提交时**：任务排队期间你改了父会话开关，已经在队列里的任务不受影响；
  `retry` 复用同一份快照。
- 子任务原有的裁剪不变：`schedule` / `monitor` / `delegate_task` 仍不装配
  （防止 subagent 再生成执行源）；继承只影响其余技能（`web`、`memory`、`goal`、`write`、用户技能）。
- 实现落在组合入口：任务创建后调用一次 `copyThreadSkills(layout, parent, task)`；
  worker 与 session-factory 不需要知道“父会话”这个概念。

### 定时任务的会话绑定

定时任务不是"全局的"，它属于创建它的那个会话。

- `Job` 增加 `originThreadId`：`schedule` 创建时写入当前会话 id。历史记录没有这个字段的，
  派发时按 `local-main` 处理，**不改写旧文件**。
- 触发时按 `originThreadId` 取会话（`hub.forThread`），那一轮作为该会话的用户消息写进
  它的历史（`⏰ [定时任务] …`），结果也只出现在这个会话；不再进主会话。
- 该会话正在跑客户端轮次就跳过、留到下次扫描（沿用现有 busy 语义，只是从"主会话忙"
  变成"来源会话忙"）。
- 技能按来源会话**当前**的覆盖加载，不是快照：改了那个会话的开关，下一次触发就用新值。
- `schedule` 在后台线程本来就不装配，所以来源一定是用户会话，不会绑到 `task-*`。
- 派发与控制的忙闲检查都按 job 的 `originThreadId` 取会话；`scheduler.isBusy()` 仍表示
  "本轮 tick / 补存未结束"的全局状态。

## 生效值计算

```
effective(skill, thread) = thread.skills.json.overrides[skill.name] ?? skill.config.defaultEnabled
```

- `skills.json` 不存在 = 没有覆盖 = 全部跟随技能默认值；**GET 不创建任何文件**。
- 覆盖表整份替换，不做增删单项；未知技能名 → 400。
- 技能目录后来被删、或覆盖里有已不存在的名字：读取时忽略，不报错。
- 新建会话默认跟随技能默认值；技能升级改 `defaultEnabled` 只影响没有覆盖的会话。

## prompt 注入

```
loadSkillsFromDir({ dir: skillsDir, source: "project" })   // pi 官方，source 只是来源标记
  → 按 effective() 过滤
  → createResourceLoader(systemPrompt, activeSkills, extensions)
  → pi 内部 formatSkillsForPrompt 渲染 <skills> 段         // 不自实现
```

- `system-prompt.ts` **不改**：basePrompt、SOUL/USER、memory、goals 段落保持原样。
- 每轮重新读技能目录、`config.json`、`skills.json`，改完下一轮生效，不需要重启。
- 只把**已启用**的技能交给 `ResourceLoader.getSkills()`；pi 自己渲染，不拼字符串。

## 技能自带工具（pi extension）

这是唯一新增的执行面，边界必须先说清：**技能里的 `extension.ts` 是服务端代码，
安装技能 = 信任其代码**。它能做的事超出一个工具的权限（pi 的 extension API 含
`api.exec`）。因此：

1. 只从 `skills/<name>/extension.ts` 加载；不扫描 `skills/*/` 下的其他 `.ts`，
   不加载 `<agentDir>/extensions`、不加载 `workspace/.pi/extensions`。
2. 用 `discoverAndLoadExtensions(绝对路径数组, discoveryCwd, discoveryAgentDir)`，
   其中 `discoveryCwd = layout.root`、`discoveryAgentDir = layout.agentDir`：
   这两个隐式目录我们从不创建，也不在文件工具可达范围内（文件工具根是
   `workspace/`），所以 discovery 实际等价于「只有显式路径」。
   **不能把 workspace 当 cwd 传进去**，否则用户往 workspace 写 `.ts` 会变成开机执行。
3. 只加载**该会话已启用**技能的 extension；关闭技能 = 不加载它的 extension，
   它的工具与事件处理器都不存在。
4. 加载失败进诊断，不阻断会话；extension 注册的工具名与内置工具同名时**拒绝该工具**
   并记诊断（不允许覆盖 guard 过的 `read`/`write`/`edit`）。
5. 工具名冲突（两个技能注册同名）保留第一个并记诊断；建议命名加技能前缀。

### allowlist 必须包含扩展工具（关键实现点）

pi 的 `createAgentSession` 把 `options.tools` 原样当作 `allowedToolNames`，
不在列表里的工具会被 `_isAllowedTool` 过滤掉，既不会声明给模型也不会执行。
所以装配顺序必须是：

1. 加载已启用技能的 extension，收集 `extension.tools` 里的工具名；
2. `tools = [...createTools() 内置工具名, ...扩展工具名]`；
3. `customTools` 仍然只有内置工具，扩展工具由 pi 的 ExtensionRunner 注入。

漏掉第 2 步的表现是「extension 加载成功但模型看不到工具」，不会有报错。

## 工具裁剪

`tools/index.ts` 的显式注册表加一张 `skill → 内置工具名` 映射（上表）。
会话装配时按 effective 值裁剪：

- 禁用技能对应的 registration 不创建 → 工具不声明、不在 allowlist。
- 未映射的内置工具（常开项）照旧按配置装配。
- **内部线程**：`task-*` 的覆盖来自父会话快照（见「三种异步路径」）；原有的后台
  裁剪规则（无 schedule / monitor / delegate_task）不变。`⏰` 定时任务跑在创建它的
  会话里，跟随该会话的开关。

## HTTP API

两个新端点（另有生命周期一节的 `DELETE /api/threads/:id`），必须登记到
`src/http/contracts/endpoints.ts`（PUT 已在 method 联合与 CORS 允许列表内），
并补 `rest.ts` / `responses.ts`：

```
GET /api/threads/:threadId/skills
  → { skills: [{ name, description, defaultEnabled, enabled }], diagnostics: [{ path, message }] }

PUT /api/threads/:threadId/skills
  body: { overrides: { [name]: boolean } }
  → 同 GET（回读后的完整列表）
```

- `threadId` 非法（不符合现有会话 id 规则）→ 400；未知技能名 → 400。
- 不认 `task-` 前缀等内部约定：接口对所有合法 `threadId` 一视同仁。
- GET 是纯查询：`skills.json` 不存在时返回全部跟随默认值，不创建目录/文件。
- PUT 写 `sessions/<threadId>/skills.json`，沿用现有临时文件 + rename 的原子写；
  不触碰 pi JSONL，因此**不推进 conversation revision**，不会让下一次发送 409，
  也不会和运行中的轮次互相干扰。
- 响应 schema 进 `responses.ts`、请求 schema 进 `rest.ts`，OpenAPI 与 `/docs` 自动跟随。

## 会话生命周期

### 主会话不可删

- 固定 id `local-main`，是默认入口。
- 启动时无条件创建（组合入口 `conversationHub.forThread("local-main")`），
  `GET /api/threads` 永远包含它——即使目录意外缺失也补上。
- 不可删除、不可改名：`DELETE /api/threads/local-main` 一律 409。

### 删除其他会话

`DELETE /api/threads/:threadId`，需要给 `EndpointSpec.method` 加 `"delete"`、
CORS `allowMethods` 加 `DELETE`，并把 `docs-contract` 的路由审计从 GET/POST/PUT
扩到 DELETE（否则新端点不在审计范围内）。

执行顺序（先刹车，再删数据，最后删目录）：

1. `local-main` → 409；会话目录不存在且没有绑定物 → 404。
2. 取消该会话正在跑的轮次并等待结束（`conversation.cancel` 已等待 `done`）。
3. 级联：删除 `originThreadId === 该会话` 的定时任务与监控（整行删除，不是 stop）；
   取消绑定到它的排队/运行中后台任务。
4. 从 hub 逐出该会话缓存，删除 `sessions/<threadId>/`（连同 `skills.json`）。

级联边界：

| 绑定物 | 处理 |
|---|---|
| 定时任务（`jobs.json`） | 整条删除 |
| 网页监控（`monitors.json`） | 整条删除（含未投递的 pendingNotification） |
| 后台任务 排队 / 运行中 | 取消，记录保留为 `cancelled` |
| 后台任务 已完成 / 失败 / 已取消 | 保留（只是历史，不会再投递） |

- **通知回落**：后台任务与监控投递时若目标会话已不存在，改投主会话，避免把已删目录重新建出来。
- 删除不可恢复；响应返回级联数量便于确认：
  `{ ok: true, removed: { jobs, monitors, tasks } }`。
- 该会话的 pending 审批随运行取消一起置为 `cancelled`；空闲会话理论上不存在 pending。
- 删除后同名重新创建是空会话，不复用任何旧数据。

## 不做的事（硬边界）

- 不做多 Agent：没有 `agents/<name>/`、per-agent 数据/调度、agent CRUD 或切换入口
- 不做 agent 间通信、独立 model、独立 SOUL/USER；工作目录与会话历史也不按会话拆
- 不按会话复制技能目录；技能只有全局一份，会话只存开关覆盖
- 不迁移任何历史数据；现有 `.pi-muse/` 结构原样保留
- 不自实现 skill 加载、system prompt 拼装、extension 执行器
- 不改 pi SDK 内部，只用公开 API（`loadSkillsFromDir`、`ResourceLoader`、
  `discoverAndLoadExtensions`）
- 不支持 SKILL.md frontmatter 声明工具；技能要带工具只能写 `extension.ts`
- 不新增 bash 工具；不让技能开关放宽写文件审批、路径边界或 `read`
- 不扫描 workspace / pi CLI 的 extensions 目录
- 不做会话改名、软删除或回收站：删除即永久删除，`local-main` 永远保留

## 验收标准

- [ ] `skills/` 不存在时首启铺出内置 7 项（含 `config.json`），二次启动不重复不覆盖
- [ ] 用户新放一个技能目录，首次扫描自动补 `config.json`（`defaultEnabled: false`）
- [ ] `GET /api/threads/:id/skills` 返回全部技能的 `defaultEnabled` 与 `enabled`
- [ ] PUT 覆盖后下一轮 system prompt 不再包含被关技能的 `<skills>` 条目
- [ ] 关闭 `cron` 后该会话模型请求的 tools 里没有 `schedule`；其他会话不受影响
- [ ] 技能自带 `extension.ts` 注册的工具出现在该会话 tools 列表；关闭技能后消失
- [ ] extension 工具与内置工具同名时被拒绝且不影响其他工具
- [ ] 两个会话覆盖不同、互不影响；重启后覆盖保持
- [ ] subagent 继承父会话：父会话关了 `cron`，新建任务的 `sessions/task-<id>/skills.json`
      里也有 `cron: false`；任务排队后改父会话不影响它
- [ ] 在会话 A 建定时任务，触发轮写进 A 的历史、不出现在 `local-main`
- [ ] A 正在跑客户端轮次时任务顺延到下次扫描，不标失败也不丢
- [ ] 定时任务按 A **当前**的覆盖加载：A 关了 `web`，触发轮没有 `search_web`
- [ ] 旧 `jobs.json`（无 `originThreadId`）按 `local-main` 派发，文件不被改写
- [ ] 主会话 `local-main` 启动即存在；`GET /api/threads` 永远包含它；DELETE 返回 409
- [ ] 删除普通会话：运行中的轮次被取消、hub 缓存被逐出、`sessions/<id>/` 消失
- [ ] 级联：该会话的 jobs/monitors 整条删除，排队或运行中的后台任务取消，
      已完成/失败的任务记录保留
- [ ] 后台任务完成时目标会话已被删除 → 通知回落到主会话，不重建已删目录
- [ ] `DELETE` 已登记端点注册表、CORS 允许、`docs-contract` 路由审计覆盖 DELETE
- [ ] PUT 不改变 `GET /api/conversation` 的 revision
- [ ] 未知技能名 / 非法 threadId → 400；`task-*` 会话照常可读写自己的覆盖
- [ ] 三个端点（GET/PUT skills、DELETE 会话）登记在 `endpoints.ts`，`/openapi.json` 与
      `/docs` 自动可见
- [ ] 集成测试：同一进程两个会话不同覆盖，各跑一轮，tools 白名单与 prompt 各自正确

## 推进顺序

1. `data-layout.ts` 加 `skillsDir` / `threadSkillsFile`；内置 7 项 SKILL.md + `config.json`
   的首次初始化与「缺配置自动补」扫描
2. 生效值计算（技能默认 + 会话覆盖）与 `GET/PUT /api/threads/:id/skills`
3. `loadSkillsFromDir` + 过滤 + `ResourceLoader.getSkills()`（pi 官方渲染）
4. 内置工具裁剪映射（`tools/index.ts`）
5. subagent 快照：任务创建时复制父会话覆盖（组合入口调用 `copyThreadSkills`）
6. 定时任务绑定会话：`Job.originThreadId` + scheduler 按来源派发 + 控制端点按来源取忙闲
7. 会话生命周期：`DELETE /api/threads/:id`、主会话保护、级联删除绑定物、通知回落
8. 技能 extension：显式路径加载、工具名并入 allowlist、诊断与冲突拒绝
9. 集成测试（隔离实例目录，走真实 HTTP + pi 链路，仅模型 mock）
