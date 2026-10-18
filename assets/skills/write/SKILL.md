---
name: write
description: 在工作目录中创建和修改文件。当用户要求“写个脚本”、“新建文件”、“修改代码”时使用。
---

# 文件写入与编辑 (Write/Edit)

本技能允许你在用户的工作目录（workspace）中创建新文件或修改现有文件。
**注意：所有写操作都需要用户的人工审批，你不能擅自执行。**

## 触发时机
- 用户说：“帮我写一个 Python 爬虫脚本”、“把这个 JSON 文件里的名字改成张三”、“新建一个 README.md”。

## 可用工具
### `write`
创建新文件。
- `path`: （必填）文件的相对路径（相对于 workspace）。
- `content`: （必填）文件的完整内容。

### `edit`
修改现有文件。
- `path`: （必填）文件的相对路径。
- `old_string`: （必填）要被替换的原始文本。
- `new_string`: （必填）替换后的新文本。

## 调用示例
用户：“帮我在当前目录新建一个 hello.py，打印 Hello World”
调用工具：`write({ path: "hello.py", content: "print('Hello World')" })`
（系统会向用户发起审批，用户同意后文件才会被创建）
