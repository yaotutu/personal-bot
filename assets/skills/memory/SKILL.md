---
name: memory
description: 记住、修改、忘掉或检索用户的长期事实。当用户明确要求“记住/忘掉”，或需要回忆以前保存的信息时使用。
---

# 长期记忆 (Memory)

长期记忆是沉淀库：不会随每轮对话整体携带，需要时用 `memory_search` 按关键词检索。

## 触发时机
- 用户说：“记住我喜欢喝美式咖啡”、“忘掉我之前告诉你的地址”、“把我老婆的生日记下来”。
- 回答可能依赖以前保存过的信息时，先检索再回答。

## 可用工具
### `memory_search`
- `query`: 关键词；`limit`: 可选，最多 10 条。
- 返回形如 `- [条目id] 内容`，按最近更新优先。

### `memory`
- `action`: `remember`（新增）、`edit`（修改）、`forget`（删除）。
- `text`: remember/edit 必填。
- `id`: edit/forget 必填，必须来自 `memory_search` 的结果，不要猜测。

## 调用示例
用户：“记住我对花生过敏” → `memory({ action: "remember", text: "用户对花生过敏" })`

用户：“忘掉我的旧地址” → 先 `memory_search({ query: "地址" })`，确认条目后 `memory({ action: "forget", id: "<id>" })`。

不要保存密码、密钥或其他秘密。
