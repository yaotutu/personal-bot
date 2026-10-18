> **已归档（2026-10-17）**：这是「每 agent 一个目录」的初版方案，已被
> [会话级技能开关](../discussions/session-skills.md) 取代。取代原因是该方案把
> 「切换单位」放到了 agent 上，实际需求只是「不同会话用不同技能集」。
> 本文仅作历史记录，**不是当前实现约定**；其中 `agents/<name>/` 六块、
> per-agent 数据与调度、path-guard 多根、agent CRUD 均未实施。

# multi-agent

> **项目：pi-muse**
>
> 状态：设计讨论中，未实现。记录于 2026-10-17。

## 数据目录

```
.pi-muse/                                ← 根：只放全局共享的东西
├── config.json / auth.key
├── SOUL.md / USER.md                    ← 全局共用：用户身份（主 agent 管）
│
└── agents/                              ← 每个 agent 自包含
    ├── default/                         ← 系统自带（始终存在；允许多 session）
    │   ├── SKILL.md                     ← agent 身份（首次启动从仓库 bundled/default/ 拷贝）
    │   ├── skills/                      ← opt-in 扩展（自带 4 项 + 用户加的）
    │   │   ├── monitor/  { SKILL.md, monitors.json }
    │   │   ├── goal/     { SKILL.md, goals.json }
    │   │   ├── task/     { SKILL.md, tasks.json }
    │   │   ├── cron/     { SKILL.md, jobs.json, runs/ }
    │   │   ├── code-review/SKILL.md
    │   │   └── bug-fix/SKILL.md
    │   ├── memory/                      ← agent 自己的（不跨 agent 共享）
    │   ├── actions/                     ← agent 自己的 write/edit 审批
    │   │   └── queue.json
    │   ├── sessions/(多) 或 session.jsonl ← agent 自己的对话历史（pi 库）
    │   └── workspace/                   ← cwd（文件工具可读写）
    │
    └── coder/                           ← 同结构；用户加的 skill 不同
```

## 原则

- **根只放真共享的**：config/auth/SOUL/USER。其余一律走 `agents/<name>/`。
- **每个 agent = 一个自包含体**：6 块（SKILL.md / skills/ / memory/ / actions/ / sessions/ / workspace/）。跨 agent 不共享任何业务数据。
- **`skills/<name>/` = opt-in 扩展目录**：每个 skill 一目录（`SKILL.md` + 可选存储）。用户写的纯 skill 和自带扩展（monitor/goal/task/cron）都用同一形态。
- **不带特殊 `tools/` 包装层**：以前那是我 YY 的，nanobot 没这层，pi-muse 也不要。
- **加 50 个扩展不会膨胀 root 或 agent 根**：扩展一律 `agents/<name>/skills/<name>/`。
- **`session-factory.ts` 的切换单位**：agent = 切 cwd；session（仅 default）= 切 JSONL。

## 三个维度

- **agent**：顶层，每个 agent = `agents/<name>/` 下一个目录
  - `default`（主 agent）：系统自带，始终存在，**允许多 session、权限高**
  - 其他：用户按需创建，**单 session 长期聊、权限低**
- **skill**：agent 内部，每个 skill = `agents/<name>/skills/<name>/` 一目录（`SKILL.md` + 可选存储）
- **session**：agent 内部，归 `agents/<name>/sessions/`（default 多）或 `agents/<name>/session.jsonl`（其他单）

切换 agent = 切 cwd；切 session（仅 default）= 切 JSONL 文件。

## default agent（主 agent）

- 始终存在，第一版启动时自动创建
- 仓库内置的 `bundled/default/SKILL.md` 拷贝到 `agents/default/SKILL.md`
- 自带 4 项扩展（monitor/goal/task/cron），第一版启动一并初始化
- **权限高**：可以读任意空间（包括其他 agent 的 workspace、memory、skills）
- 其他 agent 只能访问自己的工作区域（自己的 `workspace/` `memory/` `actions/` `skills/` 等）
- 允许删除（但 UI 要警告）

## 权限模型

| agent | 文件工具（read/write/grep）能访问 |
|---|---|
| **default（主 agent）** | 任何路径（含其他 agent 的 workspace/ memory/ skills/） |
| **其他 agent** | 仅自己的 `agents/<name>/{workspace/,memory/,actions/,skills/,...}` |

**实现**：path guard 接受 agent name，启动 session 时传允许根列表。
- 主 agent：`allowedRead = ['agents/*/...']`
- 其他 agent：`allowedRead = ['agents/<name>/...']`

**写盘也分级**：
- 主 agent 写其他 agent 的任何子目录：允许
- 其他 agent 写主 agent 区域：允许
- 其他 agent 写其他 agent 的区域：**禁止**

## session-factory

```ts
import { loadSkillsFromDir, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

const { skills } = await loadSkillsFromDir({
  dir: `agents/${agentName}/skills`,
  source: 'agent',
});

const isMainAgent = agentName === 'default';
const allowedRoots = isMainAgent
  ? [`agents/*/workspace`, `agents/*/memory`, `agents/*/actions`, `agents/*/skills`]
  : [
      `agents/${agentName}/workspace`,
      `agents/${agentName}/memory`,
      `agents/${agentName}/actions`,
      `agents/${agentName}/skills`,
    ];

const systemPrompt = basePrompt + formatSkillsForPrompt(skills);
```

`system-prompt.ts` 删自实现的 SOUL/USER 加载（SOUL/USER 现在只在根，由主 agent 管）。
`path-guard.ts` 改造为接受 allowedRoots 列表。

## HTTP API

```
GET    /api/agents                                  列出所有 agent
GET    /api/agents/<name>                           agent 信息
GET    /api/conversation?agent=<name>[&session=<id>]   读历史
POST   /api/conversation/run                        启动模型轮
POST   /api/agents                                  新建 agent（body: { name, skillMd? }）
PATCH  /api/agents/<name>                           改（body: { skillMd? }，不能改 name）
POST   /api/agents/default/sessions                 仅 default：新建 session
DELETE /api/agents/<name>                           删 agent（拒删 default）
```

## agent CRUD 边界

- **Create**：建 `agents/<name>/` 目录 + 默认 6 块布局（SKILL.md 模板 + skills/ 目录 + memory/ actions/ sessions/ workspace/ 占位）
- **Update**：改 SKILL.md 内容；**不能改 name**
- **Delete**：硬删整个目录，不可恢复
- **name 规则**：小写字母数字 + 下划线
- **数量上限**：100

## 不做的事

- agent 间通信
- agent 独立 model
- agent 独立 USER（USER 仍是全局）
- 自实现 skill 机制（用 pi 官方）
- 自实现 session 隔离（用 pi 官方）
- 自实现 system prompt 拼装
- 自实现权限模型（用 path guard）
- bash 工具

## 推进

1. 仓库内置 `bundled/default/SKILL.md` + 首次启动自动拷贝
2. `agents/<name>/` 6 块布局（SKILL.md + skills/ + memory/ + actions/ + sessions/ + workspace/）
3. `data-layout.ts` 改造：返回每 agent 的 6 块路径
4. session-factory 改造
5. `system-prompt.ts` 简化（删 SOUL/USER 自实现）
6. agent 列表 API
7. Web 端 agent 列表 UI
8. 集成测试
