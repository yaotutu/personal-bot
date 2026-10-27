<div align="center">

<img src="docs/assets/muse.png" width="112" alt="Pi Muse">

# Pi Muse

**客户端优先的开源个人智能体系统 (Personal Agent System)**

部署私有服务端，在专属手机 App 中沉浸式对话、规划目标、调度定时任务、监控网页变动、审批文件修改。

[快速开始](#快速开始) · [核心特性](#核心特性) · [为什么选择客户端优先](#为什么选择客户端优先) · [架构与安全](#架构与安全) · [Android 下载](https://github.com/yaotutu/pi-muse-mobile/releases)

[![GitHub stars](https://img.shields.io/github/stars/yaotutu/pi-muse?style=flat-square&logo=github)](https://github.com/yaotutu/pi-muse/stargazers)
[![Android Release](https://img.shields.io/badge/Android-v1.0.16%20Release-3b82f6?style=flat-square&logo=android&logoColor=white)](https://github.com/yaotutu/pi-muse-mobile/releases)
[![Node](https://img.shields.io/badge/Node.js-24%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

<br/>

<p align="center">
  <img src="docs/assets/showcase.png" width="98%" alt="Pi Muse Showcase">
</p>

</div>

---

## 为什么选择客户端优先？

大部分个人 Agent 项目往往受限于现有的即时通讯平台（如微信、飞书、Telegram）或简易的 Web 聊天窗口。但作为一个真正有用的个人生活与工作副驾驶，这种交互存在结构性限制：

1. **聊天记录承载不了完整控制台**：对话流适合即时交流，但不适合追踪长期任务。当你想修改某项定时提醒、复盘正在执行的子代理进度、打卡拆解后的目标里程碑时，在长长的聊天记录中反复翻找极其痛苦。
2. **模块各归其位**：Pi Muse 将对话、空间隔离、周期性任务、网页监控、目标里程碑和系统审批提炼为各自专属的独立页面与操作闭环。
3. **精致优雅的感官体验**：界面与交互深度参考 Muse 的设计哲学，配备生动的 3D 虚拟形象、舒适的手势交互，以及专为移动端调校的**极简日光**与**曜石暗黑**双主题。

---

## 核心特性

### 💬 智能对话与多空间隔离

<p align="center">
  <img src="docs/assets/chat-preview.png" width="88%" alt="智能对话与空间侧栏">
</p>

- **流式对话与富文本渲染**：基于 AG-UI 协议的高性能实时 SSE 推送，原生渲染 Markdown 语法、代码高亮、多级列表与内嵌工具状态卡片。
- **空间独立隔离 (Spaces)**：支持一键创建与切换“工作”、“生活”、“学习”等不同空间。每个空间享有独占的上下文对话树、专属系统提示词规则（System Prompt）以及工具挂载开关。
- **丝滑空间侧栏**：点击顶部汉堡菜单或在屏幕边缘滑出手势抽屉，直观管理与搜索你的所有空间。

---

### ⏱️ 定时任务与网页监控

<p align="center">
  <img src="docs/assets/tasks-preview.png" width="88%" alt="定时任务与网页监控">
</p>

- **自然语言排期**：无需编写复杂的 Cron 表达式，直接在聊天中交代“每天早上 9 点提醒我喝一杯水”或“每周五下午提醒写周报”，服务端调度器自动创建并维护排期。
- **无感网页持续监控**：提供任意目标网页 URL 与检测条件（如页面文本变动、命中指定关键词），服务端自动后台巡检，命中时主动推送提醒。
- **可视化状态与控制**：在“任务”页面中集中查看所有排期任务与监控项的下次运行时间、累计检查次数与最近错误信息，支持单项刷新、暂停、停止与安全删除。

---

### 🎯 长期目标与里程碑规划

<p align="center">
  <img src="docs/assets/goals-preview.png" width="52%" alt="长期目标与里程碑追踪">
</p>

- **大目标细化拆解**：将中长期愿望与规划交付给 Agent，自动梳理为具体的里程碑（Milestones）。
- **交互式打卡进度**：手机端直接点击 Checkbox 勾选完成里程碑，实时记录完成时间与整体完成比例（如 `1 / 3`）。
- **多维视图筛选**：支持按全部、进行中、已暂停、已完成、归档等多维度快速筛选，支持按更新时间与创建时间动态排序。

---

### 🛡️ 会话中心、空间规则与人工审批

<p align="center">
  <img src="docs/assets/session-preview.png" width="88%" alt="会话中心与空间规则配置">
</p>

- **全景活动中心**：在聊天页轻触顶部虚拟形象即可唤出会话中心，实时掌握 Agent 正在执行的思考过程、工具调用链与子代理协同。
- **严密的安全边界与 Diff 二次审批**：坚决不向模型暴露开放 Shell 执行权限；模型在授权工作区内发起文件创建、编辑、写入或修改长期记忆时，客户端弹出完整差异对比与确认窗口，未获人工明确点击批准绝不落盘。
- **空间级规则与技能定制**：自由为当前空间注入针对性运行指令，并可针对性开关各类技能工具（如浏览器能力）。

---

### 🌐 真实系统浏览器 (带 GUI 的 Chrome & noVNC 实时接管)

- **原生图形化浏览器**：告别容易被站点拦截的 Headless 模式，通过 Docker 提供完整的真实 Linux Chrome 桌面环境。
- **noVNC 远程投影与手动介入**：遇到图形验证码、复杂多因子登录或需人工确认的交互场景时，可随时在 App 或浏览器中打开 noVNC 远程画面实时接管操作。

---

### ⚙️ 设置中心与个性化画像

<p align="center">
  <img src="docs/assets/settings-preview.png" width="52%" alt="设置中心与个人资料">
</p>

- **连接管理**：一键配置局域网或远程服务端地址，支持连接保活检测与长效 Session Token 鉴权。
- **助手人设与用户画像**：自定义助手称呼、性格语调及关于你自己的个性化生活偏好。
- **长期记忆与 Dream 整理**：集中检索全局沉淀记忆，支持后台 Dream 机制定期整理、提取结构化认知并提交待办建议。

---

## 快速开始

### 1. 部署服务端 (`pi-muse-server`)

#### 环境依赖
- **Node.js** >= 24
- **pnpm** == 12.10.1

#### 安装与启动
```sh
# 1. 克隆代码并进入服务端目录
cd pi-muse-server

# 2. 安装工程依赖
pnpm install

# 3. 配置模型接口（支持任意兼容 OpenAI API 规范的大模型，如 Gemini、DeepSeek、OpenAI、Kimi、MiniMax 等）
# 可参考 docs/configuration.md 配置 .pi-muse/config.json

# 4. 启动本地开发服务（默认监听端口 17890）
pnpm dev
```

#### （可选）启动真实浏览器容器
如需使用真实 Chrome 浏览器与 noVNC 远程桌面接管：
```sh
# 详情见 docs/browser-docker.md
docker compose -f docker-compose.browser.yml up -d
```

---

### 2. 安装移动端 (`pi-muse-mobile`)

1. 前往 [pi-muse-mobile Releases](https://github.com/yaotutu/pi-muse-mobile/releases) 下载最新的 Android 安装包（`app-release.apk`）。
2. 在 Android 手机或模拟器中安装并启动 App。
3. 进入 **设置 -> 服务器连接**，填入你的服务端地址（如局域网 `http://192.168.x.x:17890`）和访问密钥，点击连接即可开启使用！

---

## 架构与通信协议

Pi Muse 服务端与客户端之间采用规范的无状态 REST 与双向长连接 SSE 协同通信：

1. **执行流 (AG-UI SSE)**：基于 AG-UI 协议的高保真对话执行流，承载流式 Token、工具调用分片、思考过程与结果回填。
2. **通知流 (`/api/events` 共享 SSE)**：单条长连接集中推送运行状态更新（`agent_status_updated`）、文件修改人工审批（`approval_pending`）及活动事件。
3. **业务管理流 (REST HTTP)**：严谨白名单校验的 RESTful API，用于空间切换、记忆检索、定时任务与目标里程碑维护。

---

## 数据与隐私安全

- **数据自持，隐私可控**：会话历史、任务排期、空间文件与长期记忆均持久化存储于用户自建的服务端本地，绝不经过任何第三方云端中转。
- **鉴权与网络保护**：客户端与服务端通过长期 Session Token 鉴权，明文 AccessKey 绝不持久化保存在客户端；对外请求具备严格 SSRF 过滤防护。
- **个人自用，实用为先**：遵循极简设计原则，不堆叠过度冗余的企业级抽象或防御层，聚焦真实核心场景的高效运转。

---

## 文档

- 📖 [部署指南 (Getting Started)](docs/getting-started.md)
- ⚙️ [配置说明 (Configuration)](docs/configuration.md)
- 🏗️ [架构规范 (Architecture)](docs/architecture.md)
- 🌐 [真实浏览器 Docker 说明 (Browser Docker)](docs/browser-docker.md)
- 💻 [开发与联调手册 (Development)](docs/development.md)
- 🔌 [HTTP API 契约与接口规范 (HTTP API Contract)](docs/http-api-contract.md)
- 🎨 [虚拟形象素材说明 (Avatar Assets)](docs/avatar.md)
- 🧪 [测试指南 (Testing Guide)](docs/testing.md)

---

## 致谢

- [pi](https://github.com/earendil-works/pi)：Agent 执行与会话管理
- [nanobot](https://github.com/HKUDS/nanobot)：个人助手功能的设计参考
- Muse：界面与交互设计参考
