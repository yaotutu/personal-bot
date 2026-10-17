# pi-muse 配置

pi-muse 只从一个配置文件读取启动配置：

```text
.pi-muse/config.json
```

该文件必须存在；缺失、JSON 语法错误、未知字段、类型不合法或未知 `schemaVersion` 都会启动失败。服务端不支持旧的环境变量配置，也不支持 `${ENV_NAME}` 插值。模型 API key 直接写在 `model.apiKey`。自有 `web/` 的 `API_TARGET` 只用于 Vite 的 `/api` 代理，不是服务端配置来源。

## 创建配置

~~~sh
mkdir -p .pi-muse
cp config.example.json .pi-muse/config.json
chmod 600 .pi-muse/config.json
~~~

然后编辑：

~~~json
{
  "schemaVersion": 1,
  "server": {
    "host": "0.0.0.0",
    "port": 17890,
    "accessKey": "",
    "allowedOrigins": [
      "http://localhost:15173",
      "http://127.0.0.1:15173"
    ]
  },
  "model": {
    "baseUrl": "http://127.0.0.1:8000/v1",
    "id": "my-model",
    "apiKey": "paste-model-api-key-here",
    "contextWindow": 32768,
    "maxTokens": 4096
  },
  "runtime": {
    "runTimeoutMs": 120000,
    "schedulerIntervalMs": 30000
  },
  "tools": {
    "writable": {
      "enabled": true,
      "actionTimeoutMs": 300000
    },
    "web": {
      "enabled": true
    },
    "weather": {
      "enabled": true,
      "defaultCity": "上海"
    },
    "presentation": {
      "default": "hidden",
      "overrides": {
        "currentTime": "summary",
        "get_weather": "summary",
        "search_web": "summary",
        "memory": "summary",
        "schedule": "summary"
      }
    }
  }
}
~~~

所有 section 和字段都可以按需省略；省略后使用内置默认值。`schemaVersion` 当前为 `1`。

## 字段说明

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `server.host` | `0.0.0.0` | 默认监听全部网卡便于局域网访问；非回环 host 但 `server.accessKey` 为空时仅打印警告，由用户自行决定是否补上 |
| `server.port` | `17890` | HTTP 监听端口；被占用时启动直接报错并指出占用 PID（用 `lsof` 查，跨平台不兼容时退化为通用提示），由用户决定改 port 还是 `kill -15 <pid>` 释放 |
| `server.accessKey` | 空 | 服务访问密钥，不是模型 key；留空启动会打印非回环 host 的安全警告，但不会阻断启动 |
| `server.allowedOrigins` | localhost / 127.0.0.1 的 15173、17890 共四个 origin | CORS origin 数组；显式配置会替换默认列表，用于自有 Web |
| `model.baseUrl` | 空 | OpenAI-compatible API 根地址，例如 `/v1`；必须与 `model.id` 同时配置 |
| `model.id` | 空 | 模型 ID |
| `model.apiKey` | 空 | 模型 API key，直接写在配置文件中 |
| `model.contextWindow` | `32768` | 必须大于 `model.maxTokens` |
| `model.maxTokens` | `4096` | 模型输出上限 |
| `runtime.runTimeoutMs` | `120000` | 客户端轮超时 |
| `runtime.schedulerIntervalMs` | `30000` | 定时任务扫描间隔 |
| `runtime.monitorScanIntervalMs` | `60000` | 网页监控扫描间隔 |
| `runtime.dataDir` | 配置文件所在目录 | 相对路径按配置文件所在目录解析；推荐绝对路径，但不强制 |
| `tools.writable.enabled` | `true` | 是否注册 `write` / `edit`；开启后仍需逐次人工审批 |
| `tools.writable.actionTimeoutMs` | `300000` | 文件操作审批有效期（毫秒）；过期不能提交修改 |
| `tools.web.enabled` | `true` | 是否向模型声明 `search_web` / `web_fetch` |
| `tools.web.timeoutMs` | `30000` | 单次 Web 请求超时 |
| `tools.web.maxResponseBytes` | `2000000` | 单次响应大小上限 |
| `tools.web.maxContentChars` | `50000` | `web_fetch` 默认返回字符上限 |
| `tools.web.searchResults` | `5` | 默认搜索结果数，工具参数最大 10 |
| `tools.web.userAgent` | 浏览器 UA | Web 请求 User-Agent |
| `tools.web.allowPrivateTargets` | `false` | 仅本机联调时显式放宽私网/回环目标限制；其余请求安全边界不变 |
| `tools.weather.enabled` | `true` | 是否向模型声明 `get_weather` |
| `tools.weather.defaultCity` | 空 | 用户未指定城市时使用的默认城市；为空时模型会追问城市 |
| `tools.presentation.default` | `hidden` | 客户端实时流与历史投影的工具展示策略：`hidden` 隐藏工具调用，`summary` 只发送受控摘要 |
| `tools.presentation.overrides` | `{}` | 按工具名覆盖默认策略；名称以 `src/adapters/pi/tools/index.ts` 的显式注册表为准，包括 `currentTime`、`memory`、`schedule`、`delegate_task`、`goal`、`monitor`、`read`、`grep`、`find`、`ls`、`write`、`edit`、`search_web`、`web_fetch`、`get_weather` |

默认情况下，`.pi-muse/config.json` 所在的 `.pi-muse/` 同时也是实例数据目录。当前默认实例目录已统一为 `.pi-muse/`，旧目录不会被自动读取或迁移。也就是说 sessions、memory、jobs、workspace 和配置文件保持在同一个实例目录内。
`runtime.dataDir: "."` 也表示该配置文件目录，与启动进程的 cwd 无关；若在 `.pi-muse/config.json` 中填 `".pi-muse"`，则会指向其下嵌套的 `.pi-muse/`，不是项目根目录下的同名目录。
会话按 `sessions/<threadId>/` 保存，每个 thread 有独立 pi 会话；单用户可有多个 thread，内部后台任务 `task-*` 不显示在用户会话列表中。

## 实例目录改名

旧 `.personal-bot/` 不会自动回退读取。迁移必须先停服务并保留受保护备份，除配置中的绝对 runtime.dataDir 外，还要离线更新pi JSONL会话头的cwd及指向实例内的parentSession路径前缀；仅移动文件会使continueRecent跳过旧会话。消息正文和会话ID不变，文件mtime需保留以免改变最近会话选择；auth.key与accessKey不变才能继续使用原token。本实例迁移记录及回退方式见 `HANDOFF.md`；`.pi-muse-backups/` 含凭据，必须保持0700目录及0600敏感文件权限，不提交或上传。

## 文件写入审批

- `write` / `edit` 只能操作 `DATA_DIR/workspace` 内的文件，拒绝绝对路径、`..` 逃逸和目标/父目录符号链接；`bash` 永不暴露。
- 每次操作都需独立人工审批，审批载荷保留完整修改前后文本和文件版本；`edit` 的待替换文本必须唯一命中。
- 提交前重新检查路径安全与文件版本。文件在等待期间变化时，旧审批不能授权覆盖，需重新发起操作和审批。
- 拒绝、审批过期或运行取消均不会提交该次修改；服务重启会取消上一进程遗留的 pending 审批。审批有效期由登记时的 `expiresAt` 固定，提交前再次校验期限和取消状态。
- 关闭 `tools.writable.enabled` 会移除这两个工具；工具展示策略不能跳过审批或开启被关闭的写入能力。

## 工具展示策略

展示配置影响自有 Web消费的实时流与历史投影，不禁用工具、不改变模型收到的完整结果，也不改写 pi JSONL。修改配置后重启服务生效；已有历史会按当前策略重新投影，没有第二套历史或在线迁移。文件操作审批是独立的安全流程，不因隐藏工具卡片而省略。

- `hidden`：实时流不发送该工具的整组 `TOOL_CALL_*`，历史不返回该调用及对应工具结果。只保留普通 user/assistant 文本。
- `summary`：使用原工具名和稳定 ID 展示现有卡片，参数统一为 `{}`，结果采用受控摘要。例如保存记忆只显示“已保存记忆”，不显示记忆原文；读文件只确认执行结束，不展示正文。
- 搜索摘要保留来源 URL/title，删除 snippet 和供应商诊断，去掉 URL query/fragment（依赖 query 的来源链接可能无法直达；需要原链接时由最终回答提供）。搜索失败使用合法 `{error}`，不会伪造成“找到 0 条来源”。
- 示例配置显式开启时间、天气、搜索、记忆、提醒摘要；**省略整个 presentation 时所有工具默认隐藏**。未知工具名/无效模式启动失败。可以为关闭的 Web/天气工具预先配置策略，但展示配置不能开启这些能力。
- 这是展示选择，不是信息保密边界：模型仍可在最终回答中引用原始结果；调用前“我先查一下”等普通 assistant 文本仍然流式展示。`summary` 仍然有卡片，不是完全静默。

如果希望聊天只显示助手文本，在现有 `tools` section 内加入：

~~~json
"presentation": {
  "default": "hidden",
  "overrides": {}
}
~~~

## 错误策略

- 配置文件是必需文件，不存在不会回退到环境变量。
- JSON 语法错误、未知字段、类型不合法、未知 `schemaVersion` 会启动失败。
- `model.baseUrl` 与 `model.id` 必须同时为空或同时配置。
- `model.baseUrl` 只接受无凭据、无 query、无 fragment 的 HTTP(S) URL。
- 非回环 `server.host` 推荐配置 `server.accessKey`；当前默认行为是 host 为 `0.0.0.0` 但留空 accessKey 时仅打印警告而非阻断。
- 服务不会自动创建或改写配置文件，避免启动路径意外覆盖用户手写配置。
- Web 请求默认只允许公网 HTTP(S)，阻断回环、私网、链路本地和保留地址；每个重定向都会重新校验。本机联调可显式设置 `tools.web.allowPrivateTargets: true`，不改变其余请求安全约束。

## 密钥与文件权限

`config.json` 可能同时包含模型 key 和工作区访问密钥：

- 不提交到 Git；`.pi-muse/` 已在 gitignore 中。
- 不截图、不在聊天中粘贴完整内容。
- 建议权限保持 `0600`。
- 服务端不会把 key 写入日志、返回客户端或写入 pi 会话文件。
- 备份配置文件时按敏感凭据同等保护。

## mock 配置

`pnpm dev:mock` 不读取 `.pi-muse/config.json`，也不调用真实模型。它在 `scripts/dev-mock.ts` 中显式构造隔离配置：

- 监听 `127.0.0.1:17891`
- 使用 fake provider
- 数据目录为 `.pi-muse/mock`

mock 的端口和目录不提供环境变量覆盖；确需调整时直接修改脚本中的显式配置对象。
