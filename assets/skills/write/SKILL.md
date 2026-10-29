---
name: write
description: 在工作目录中创建和修改文件。当用户要求“写个脚本”、“新建文件”、“修改代码”时使用。
---

# 受审批文件写入与编辑 (Write/Edit)

本技能允许你在当前空间的私有工作区创建或完整覆盖文件，也可通过 `shared/...` 修改共享文件；`edit` 只替换一处唯一文本。所有写操作都需要用户审批，审批会展示完整 before/after。路径必须是相对入口，拒绝绝对路径、`..` 穿越和符号链接；单文件上限 100KB。保存脚本或其他文件不代表可以执行：本产品不提供 `bash`。

## 触发时机
- 用户说：“帮我写一个 Python 爬虫脚本”、“把这个 JSON 文件里的名字改成张三”、“新建一个 README.md”。

## 可用工具
### `write`
创建或完整覆盖一个文件。
- `path`: （必填）文件的相对路径（相对于 workspace）。
- `content`: （必填）文件的完整内容。

### `edit`
修改现有文件。
- `path`: （必填）文件的相对路径。
- `oldText`: （必填）要被替换的原始文本，必须在文件中唯一出现。
- `newText`: （必填）替换后的新文本。

## 调用示例
用户：“帮我在当前目录新建一个 hello.py，打印 Hello World”
调用工具：`write({ path: "hello.py", content: "print('Hello World')" })`
（系统会向用户发起审批，用户同意后文件才会被创建）

用户：“把 hello.py 里的 Hello World 改成 Pi Muse”
调用工具：`edit({ path: "hello.py", oldText: "print('Hello World')", newText: "print('Pi Muse')" })`
（同样需要人工审批；替换后的完整文件不能超过 100KB）
