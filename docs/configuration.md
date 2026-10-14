# Personal Bot 配置

Personal Bot 只从一个配置文件读取启动配置：

```text
.personal-bot/config.json
```

该文件必须存在；缺失、JSON 语法错误、未知字段、类型不合法或未知 `schemaVersion` 都会启动失败。项目不再支持旧的环境变量配置，也不支持 `${ENV_NAME}` 插值。模型 API key 直接写在 `model.apiKey`。

## 创建配置

~~~sh
mkdir -p .personal-bot
cp config.example.json .personal-bot/config.json
chmod 600 .personal-bot/config.json
~~~

然后编辑：

~~~json
{
  "schemaVersion": 1,
  "server": {
    "host": "127.0.0.1",
    "port": 8787,
    "accessKey": "",
    "allowedOrigins": ["http://localhost:8081"]
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
| `server.host` | `127.0.0.1` | 非回环地址必须配置 `server.accessKey` |
| `server.port` | `8787` | HTTP 监听端口 |
| `server.accessKey` | 空 | OpenMuse 工作区访问密钥，不是模型 key |
| `server.allowedOrigins` | localhost:8081 两个 origin | CORS origin 数组 |
| `model.baseUrl` | 空 | OpenAI-compatible API 根地址，例如 `/v1`；必须与 `model.id` 同时配置 |
| `model.id` | 空 | 模型 ID |
| `model.apiKey` | 空 | 模型 API key，直接写在配置文件中 |
| `model.contextWindow` | `32768` | 必须大于 `model.maxTokens` |
| `model.maxTokens` | `4096` | 模型输出上限 |
| `runtime.runTimeoutMs` | `120000` | 客户端轮超时 |
| `runtime.schedulerIntervalMs` | `30000` | 定时任务扫描间隔 |
| `runtime.dataDir` | 配置文件所在目录 | 相对路径相对配置文件解析 |
| `tools.web.enabled` | `true` | 是否向模型声明 `search_web` / `web_fetch` |
| `tools.web.timeoutMs` | `30000` | 单次 Web 请求超时 |
| `tools.web.maxResponseBytes` | `2000000` | 单次响应大小上限 |
| `tools.web.maxContentChars` | `50000` | `web_fetch` 默认返回字符上限 |
| `tools.web.searchResults` | `5` | 默认搜索结果数，工具参数最大 10 |
| `tools.web.userAgent` | 浏览器 UA | Web 请求 User-Agent |
| `tools.weather.enabled` | `true` | 是否向模型声明 `get_weather` |
| `tools.weather.defaultCity` | 空 | 用户未指定城市时使用的默认城市；为空时模型会追问城市 |
| `tools.presentation.default` | `hidden` | 工具在 OpenMuse 聊天中的展示策略：`hidden` 不发送工具卡片，`summary` 只发送受控摘要 |
| `tools.presentation.overrides` | `{}` | 按工具名覆盖默认展示策略；可配置 `currentTime`、`get_weather`、`search_web`、`memory`、`schedule`、`read`、`grep`、`find`、`ls`、`web_fetch` |

默认情况下，`.personal-bot/config.json` 所在的 `.personal-bot/` 同时也是实例数据目录。也就是说 sessions、memory、jobs、workspace 和配置文件保持在同一个实例目录内。

## 工具展示策略

展示配置只影响 OpenMuse 聊天，不禁用工具、不改变模型收到的完整结果，也不改写 pi JSONL。修改配置后重启服务生效；已有历史会按当前策略重新投影，没有第二套历史或在线迁移。

- `hidden`：实时流不发送该工具的整组 `TOOL_CALL_*`，历史不返回该调用及对应工具结果。只保留普通 user/assistant 文本。
- `summary`：使用原工具名和稳定 ID 展示现有卡片，参数统一为 `{}`，结果采用受控摘要。例如保存记忆只显示“已保存记忆”，不显示记忆原文；读文件只确认执行结束，不展示正文。
- 搜索摘要保留 SearchToolCard 要求的来源 URL/title，删除 snippet 和供应商诊断，去掉 URL query/fragment（依赖 query 的来源链接可能无法直达；需要原链接时由最终回答提供）。搜索失败使用合法 `{error}`，不会伪造成“找到 0 条来源”。
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
- 非回环 `server.host` 必须配置 `server.accessKey`。
- 服务不会自动创建或改写配置文件，避免启动路径意外覆盖用户手写配置。
- Web 请求只允许公网 HTTP(S)，阻断回环、私网、链路本地和保留地址；每个重定向都会重新校验。

## 密钥与文件权限

`config.json` 可能同时包含模型 key 和工作区访问密钥：

- 不提交到 Git；`.personal-bot/` 已在 gitignore 中。
- 不截图、不在聊天中粘贴完整内容。
- 建议权限保持 `0600`。
- 服务端不会把 key 写入日志、返回客户端或写入 pi 会话文件。
- 备份配置文件时按敏感凭据同等保护。

## mock 配置

`pnpm dev:mock` 不读取 `.personal-bot/config.json`，也不调用真实模型。它在 `scripts/dev-mock.ts` 中显式构造隔离配置：

- 监听 `127.0.0.1:8788`
- 使用 fake provider
- 数据目录为 `.personal-bot/mock`

mock 的端口和目录不提供环境变量覆盖；确需调整时直接修改脚本中的显式配置对象。
