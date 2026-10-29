---
name: goal
description: 设定和追踪长期目标。当用户表达长期意愿、计划或需要持续跟进的事项时使用。
---

# 目标管理 (Goal)

本技能允许你记录和追踪用户的长期目标，帮助用户保持对重要事项的关注。

## 触发时机
- 用户说：“我今年想学会游泳”、“我的目标是减肥10斤”、“我要开始准备考研了”。

## 可用工具
### `goal`
用于管理长期目标。

**参数说明：**
- `action`: 操作类型，可选 `create`（创建）、`list`（列出所有）、`check`（切换里程碑）、`status`（修改状态）。
- `title`: （所有 action 都必填；非 create 传占位文本）创建时是目标标题。
- `description`: （创建时可选）目标的详细说明。
- `category`、`milestones`: （创建时可选）分类与里程碑短标题数组。
- `goalId`: （`check`/`status` 必填）目标 ID，先由 `list` 查询。
- `milestoneId`: （`check` 必填）里程碑 ID，同样来自 `list`。
- `status`: （`status` 必填）目标新状态，只能是 `active`、`paused`、`completed` 或 `archived`。

## 调用示例
用户：“我想在年底前读完10本书”
调用工具：`goal({ action: "create", title: "年底读完10本书", description: "提升阅读量，涵盖历史和科幻类", milestones: ["读3本历史", "读4本科幻", "读3本自选"] })`

用户：“把刚才目标里的第一个里程碑标记完成”
先调用 `goal({ action: "list", title: "-" })` 获取 ID，再调用 `goal({ action: "check", title: "-", goalId: "<目标ID>", milestoneId: "<里程碑ID>" })`。
