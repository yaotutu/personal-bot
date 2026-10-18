---
name: task
description: 把子任务交给一个隔离上下文的子代理（subagent）执行。当你需要减少父对话的上下文污染、或把一个明确子任务切出去时使用。
---

# 子代理派发 (Subagent)

本技能允许你把任务交给一个独立上下文窗口的子代理（subagent）完成，结果回到主模型继续处理。
父代理通过一次工具调用即**同步等待** child 返回（不释放锁、不在后台并发），你不能承诺给用户弹通知、在任务页里查看、或由用户在 Web 直接创建。核心收益是**减少父上下文污染**与**明确子任务切分**。

## 触发时机
- 子任务本身需要太多步探索，会污染父对话的上下文窗口。
- 需要把同一任务交给多份视角（如 scout × N）汇总时。
- 需要一个清晰、可独立交付的子步骤，便于复盘或交接给另一个 agent。

## 可用代理
- `scout` — 只读侦察，按 grep/find/read 选关键位置，给出文件位置和关键片段。
- `planner` — 只读分析，把需求拆成可执行的步骤清单。
- `reviewer` — 只读复核，已经改动的内容做质量与一致性检查。
- `worker` — 执行代理，受父代理权限上限约束（写仍走审批，不可发起 schedule/monitor/subagent/instructions）。

## 调用方式
主模型自主选择代理与模式。任何调用都不接受 `cwd` 或 `agentScope`：每个 child 在独立的上下文窗口与私有 `workspace/threads/subagent-<uuid>/` 根中运行，与父代理的私有根互不可见；只有 `shared/` 在父子之间互通。

### single — 单代理
```json
{ "agent": "scout", "task": "在 workspace 里找出与认证相关的入口文件，列出关键行号。" }
```
`task` 是面向该子代理的完整说明；子代理不知道当前对话历史，需要把背景一并写清楚。

### parallel — 并行多代理
```json
{
  "tasks": [
    { "agent": "scout", "task": "梳理 model 相关的文件与依赖。" },
    { "agent": "scout", "task": "梳理 provider 相关的文件与依赖。" }
  ]
}
```
各任务并发执行；返回给主模型的是每个子代理的最终摘要。

### chain — 顺序链路
```json
{
  "chain": [
    { "agent": "scout", "task": "找到 read 工具的实现位置和它依赖的接口。" },
    { "agent": "planner", "task": "基于上面的发现，给出 read 工具的改进步骤。" }
  ]
}
```
下一步可以用 `{previous}` 占位上一节点的输出。

## 调用边界
- 结果回到**父模型**，而不是直接落到聊天；父代理拿到后再继续生成后续回复。**不要**承诺后台通知、任务页记录、用户直接管理入口。
- 父代理对权限负责：worker 的 `write`/`edit` 仍需用户审批；
  scheduler / monitor / 子代理 / 指令（schedule/monitor/subagent/instructions）这些会扩张副作用面与后端状态的能力都不可调用。
- 你是个人助手，不是完整操作系统：保持任务简洁，避免触碰 `/etc`、`~/.ssh`、原始 dotfiles 等越界路径。child 只能在它自己的私有根（`workspace/threads/subagent-<uuid>/`）和 `shared/` 下读写。
