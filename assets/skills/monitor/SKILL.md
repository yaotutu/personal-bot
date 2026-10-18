---
name: monitor
description: 监控网页内容变化或关键词。当用户要求“盯着这个网页”、“有货了告诉我”、“关注这个链接”时使用。
---

# 网页监控 (Monitor)

本技能允许你为用户监控指定的网页，当内容发生变化或出现特定关键词时通知用户。

## 触发时机
- 用户说：“帮我盯着这个商品链接，降价了告诉我”、“监控这个新闻页面，有更新就通知我”。

## 可用工具
### `monitor`
用于管理网页监控任务。

**参数说明：**
- `action`: 操作类型，可选 `create`（创建）、`list`（列出）、`pause`（暂停）、`resume`（恢复）、`stop`（停止）。
- `url`: （创建时必填）要监控的网页链接，必须是公网可访问的 HTTP/HTTPS 链接。
- `type`: （创建时必填）监控类型，`change`（内容任何变化）或 `contains`（出现特定关键词）。
- `keyword`: （type 为 contains 时必填）要监控的关键词。

## 调用示例
用户：“帮我盯着 https://example.com/item，如果出现‘补货’两个字就告诉我”
调用工具：`monitor({ action: "create", url: "https://example.com/item", type: "contains", keyword: "补货" })`
