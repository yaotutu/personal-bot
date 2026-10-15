# OpenMuse 客户端接口契约盘点

日期：2026-10-10。状态：静态盘点基线保留；P1 最小契约已实现并完成 Web mock 联调，增量说明见文末。

## 1. 基线与范围

OpenMuse：/Users/yaotutu/Desktop/code/openmuse

- Git HEAD：1ac68f3909f2478ab6280883f1ab5ea65eb5719d。
- 当前本地修改：.env.example、apps/server/src/agent.ts、app.ts、config.ts、workspace.ts，以及未跟踪的AGENTS.md；以本地代码为准，未改动这些文件。
- 运行时协议：已安装 @copilotkit/core/runtime 1.70.1 与 @ag-ui/core/client 0.0.59。
- 客户端主体：apps/mobile，Expo跨Web/iOS/Android；本轮没有发现需要单独实现另一套桌面客户端API。
- 本清单从客户端实际调用出发，不把服务端每条路由都视为必须重写。
- P1采用richThreads=false，本地主会话local-main。富线程API不属于首期。

三个标记：A=首期必须，B=功能按需/延后，C=富线程或样例专用。
未开放能力返回诚实空快照/未配置状态，mutation返回明确JSON错误；不要伪造任务成功或注入sample个人数据。


### 本地修改文件指纹（防止仅用HEAD遗漏本地差异）

| 文件 | SHA-256 |
| --- | --- |
| .env.example | adac0938452d55f598f18eb7c50364bc6773cc35f54a16dda1ef7c3b822aeaad |
| apps/server/src/agent.ts | 9d184528ca26fe8fd82756af50c40ec013c3f24abd97a02265c33064ba98604f |
| apps/server/src/app.ts | b7b71b952a2fbb0e59fa4deab1ff9de510c8a7178c987533d321a2178231adda |
| apps/server/src/config.ts | b1c2bf2c41ec510589bedf622a6a1146141262b333103f1d35b92bd0f4cb1c82 |
| apps/server/src/workspace.ts | e55120f64f7bac2b03ae3f8484f2fc9b2f49d396447693073d4739403be5fd19 |
| AGENTS.md | 8809d542722f236fa8cef9a6a57cbab2104bb32d48fdaa75cf1626475818442e |

## 2. 共同规则

### 地址、鉴权、成功和错误

- API地址由EXPO_PUBLIC_API_URL控制；Android默认10.0.2.2:8787，其余默认localhost:8787。真机必须使用可达的服务端地址。
- POST session不要求Bearer；后续普通API与runtime请求均携带Authorization: Bearer <token>。
- MuseApi无body默认GET，有body默认POST；可以显式指定PUT。
- JSON请求用Content-Type: application/json。文件上传用multipart，不能手动套JSON。
- 普通API成功必须有JSON body，空204不兼容readApiPayload。
- 错误建议非2xx + {error:string}。现有服务端非法JSON400、校验422、鉴权401、通用异常通常502。
- 浏览器CORS预检需允许Authorization、Content-Type及实际使用的GET/POST/PUT等方法，配置明确origin白名单。
- 资源下载/iframe/Image路由是例外：成功不是JSON，需要匹配其资源Content-Type。

证据：

- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/api.ts:4
- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/api-response.ts:6
- /Users/yaotutu/Desktop/code/openmuse/apps/server/src/app.ts:58
- /Users/yaotutu/Desktop/code/openmuse/apps/server/src/auth.ts:15

### 请求时序

~~~text
POST session → token → GET workspace → 工作区挂载
  ├─ runtime GET info → agent ready
  ├─ GET agent → 可见时每3秒轮询
  └─ GET conversation → 设置历史 → 允许发送

添加user message → POST default/run → SSE事件
  → 完成后刷新workspace/agent
  → finally PUT conversation（成功、错误、停止均需考虑）
~~~

严格说session/workspace失败会阻断工作区；agent请求失败被捕获，不阻断壳层，但会反复报错，所以P1也实现空agent快照。
空白聊天首页不会主动请求computer；进入Computer面板时会请求，Browser标签下隐藏的LinuxWorkspace也仍挂载。

## 3. 首期接口表

| 标记 | Method | Path | 请求 / 响应 | 触发 |
| --- | --- | --- | --- | --- |
| A | POST | /api/session | {accessKey?:string} → {token:string,mode:sample或live} | 应用启动/登录 |
| A | GET | /api/workspace | 无 → Workspace | 首次载入、前台恢复、聊天完成 |
| A | GET | /api/agent | 无 → AgentWorkspace | 挂载、可见时轮询、聊天完成 |
| A | GET | /api/conversation | 无 → {messages:Message[]} | 本地模式历史恢复 |
| A | PUT | /api/conversation | {messages:Message[]} → {ok:true} | 每轮finally |
| A | GET | /api/copilotkit/info | 无 → RuntimeInfo，必须包含agents.default | SDK发现runtime |
| A | POST | /api/copilotkit/agent/default/run | RunAgentInput → AG-UI SSE | 聊天运行 |
| A | POST | /api/copilotkit/agent/default/stop/:threadId | 无body → JSON停止响应 | 点击停止 |
| 运维 | GET | /api/health | 无 → {ok:boolean,...} | 健康检查，不是当前首页必发请求 |
| C | GET | /api/main-thread | 无 → {threadId:string,existing:boolean} | richThreads=true时初始化 |

证据：

- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/App.tsx:93
- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/App.tsx:153
- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/agent-workspace.tsx:34
- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/chat.tsx:300
- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/chat.tsx:321
- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/threads.tsx:40

### 3.1 session

请求示例：{} 或 {accessKey:"..."}。成功示例：{token:"...",mode:"live"}。

现有实现单owner local-user、token有效期24小时。新后端无需照抄它的数据库实现，但应保留调用语义；模型API key与accessKey完全不同。
若live模式启用accessKey，客户端第一次无key请求应得到401并进入已有输入流程，不应返回假token。

### 3.2 workspace：建议首期合法空快照

~~~json
{
  "mode": "live",
  "profile": { "name": "You", "email": "" },
  "mail": [],
  "events": [],
  "files": [],
  "browsers": [],
  "actions": [],
  "activity": [],
  "connections": [],
  "runtime": {
    "provider": "model",
    "configured": true,
    "openbotConfigured": false,
    "richThreads": false
  }
}
~~~

configured必须反映实际模型配置，而非固定true；这不证明endpoint健康。provider沿用domain允许的model，不能直接塞入pi这个新枚举值。
connections可为空或返回已有合法的unconfigured/disconnected条目；不声称已连接Google/Browser。

原类型：/Users/yaotutu/Desktop/code/openmuse/packages/domain/src/index.ts:183
当前生成：/Users/yaotutu/Desktop/code/openmuse/apps/server/src/workspace.ts:321

### 3.3 agent：建议首期合法空快照

~~~json
{
  "tasks": [], "goals": [], "monitors": [], "ideas": [],
  "memories": [], "artifacts": [], "notifications": [],
  "identity": { "name": "Personal Bot", "tone": "concise" },
  "worker": { "running": false }
}
~~~

identity.name/tone和worker.running不能省略。running=false仅描述后台worker，不表示聊天不能运行。
类型：/Users/yaotutu/Desktop/code/openmuse/packages/domain/src/agent.ts:118

### 3.4 conversation：现有契约与新后端权威性

现有OpenMuse GET从数据库取messages，空时[]；PUT验证每条AG-UI Message后全量覆盖数据库，最多1000条，返回{ok:true}。
证据：/Users/yaotutu/Desktop/code/openmuse/apps/server/src/app.ts:237

对新服务端的建议（这是有意的语义收紧，不是原接口已提供的保证）：

- pi持久session是模型执行历史权威；GET返回完整显示历史的AG-UI投影。
- UI投影不能只用buildSessionContext：compaction后上下文不是完整历史，应由active branch的message entries与必要的稳定ID元数据生成。
- 每轮run只接受未处理的新user输入，不把客户端携带的完整messages重复喂给pi。
- 保存客户端user message ID、assistant message ID与pi entry的映射，跨重启稳定；不要每次GET生成随机ID。
- PUT不得把客户端assistant/tool历史反灌进pi，不得覆盖canonical已提交历史。对相同已提交投影可返回ok；差异/陈旧快照返回可理解冲突并要求重新GET。
- 失败、取消和断流会产生不完整assistant显示文本。需在P1a确认如何与pi最终message保持一致；不能用盲目no-op PUT返回成功掩盖丢失。
- 正常消息的canonical提交应在RUN_FINISHED之前完成，避免客户端finally写回时存在提交竞态。
- run在接受新输入前校验客户端历史与服务端的已提交前缀；不允许客户端重写过去的消息。已接受但失败的同一user ID重试应继续该用户轮次，而不是重复append。
- 运行中拒绝新的run；下一轮在pi idle后开始。runId与user ID分别负责请求去重和消息去重。

这是P1关键验证项。若完全不改客户端难以可靠处理冲突，允许小改chat同步行为：run后以服务端GET为准，或停用盲目全量PUT；接口路径可以继续保留。
首期不承诺恢复执行中的run或跨多标签实时同步。已正常完成历史的刷新/重启恢复必须支持。

### 3.5 runtime info

SDK默认先GET /info，成功则走REST路由；否则fallback到single-endpoint POST。
P1必须让GET /info成功，不需要顺手实现fallback协议。

客户端读取agents字典、每个agent的description/capabilities、mode等。当前runtime响应还包含version、audioFileTranscriptionEnabled、threadEndpoints、suggestions、A2UI和generative UI标记等。
优先复用现有本地runtime生成真实schema，不编造版本或声明未实现能力。直接路由备选的最小示例如下，需contract test确认，不是已测结果：

~~~json
{
  "agents": { "default": { "name": "default", "description": "Personal assistant" } },
  "mode": "sse",
  "audioFileTranscriptionEnabled": false,
  "suggestions": false,
  "a2uiEnabled": false,
  "openGenerativeUIEnabled": false,
  "telemetryDisabled": true
}
~~~

证据：

- /Users/yaotutu/Desktop/code/openmuse/node_modules/@copilotkit/core/dist/index.mjs:1719
- /Users/yaotutu/Desktop/code/openmuse/node_modules/@copilotkit/core/dist/index.mjs:1861
- /Users/yaotutu/Desktop/code/openmuse/node_modules/@copilotkit/runtime/dist/v2/runtime/handlers/get-runtime-info.mjs:64

### 3.6 run / SSE

headers：Authorization Bearer、Content-Type application/json；响应Content-Type text/event-stream。

request遵循已安装的RunAgentInputSchema，包括threadId、runId、messages、state、tools、context及可选forwardedProps。消息是AG-UI Message联合类型，不能替换成OpenAI wire message。
首期只允许local-main/default，接受schema合法但尚未启用的字段，不把客户端tools当作可执行后端工具，不采纳客户端提供的权限和model。

~~~json
{
  "threadId": "local-main",
  "runId": "run-id",
  "messages": [{ "id": "user-id", "role": "user", "content": "你好" }],
  "state": {}, "tools": [], "context": [], "forwardedProps": {}
}
~~~

SSE每帧：data: <AG-UI JSON>，后跟两个换行。不要返回{delta:...}自定义协议，也不是OpenAI的[DONE]流。

正常纯文本事件顺序：

~~~text
RUN_STARTED {threadId,runId}
TEXT_MESSAGE_START {messageId,role:"assistant"}
TEXT_MESSAGE_CONTENT {messageId,delta}  // 可重复
TEXT_MESSAGE_END {messageId}
RUN_FINISHED {threadId,runId}
~~~

错误：RUN_ERROR {message,code?}后终止，不再发送假RUN_FINISHED；流开启前拒绝则HTTP JSON错误。
用户取消可用当前runtime的STOPPED约定，错误展示行为需要真实客户端验收。
客户端特殊会话锁错误码为agent_thread_locked / AgentThreadLockedError；自定义HTTP 409不自动等于该错误码，需要复用runtime或验证映射。

已有SDK schema / parser优先复用；事件ID、顺序与UTF-8正确性需fixture测试。首期不发送模型内部reasoning内容。
证据：

- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/chat.tsx:219
- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/chat.tsx:333
- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/conversation-run.ts:7
- /Users/yaotutu/Desktop/code/openmuse/node_modules/@copilotkit/core/dist/index.mjs:640

### 3.7 stop 与断线

路径包含实际threadId；无body。现有handler成功返回：

- 有活动run：{stopped:true,interrupt:{type:"RUN_ERROR",message:"Run stopped by user",code:"STOPPED"}}。
- 无活动run：{stopped:false,message:"No active run for thread ..."}，HTTP200。

当前SDK发stop为异步fire-and-forget；runtime InMemory runner调用agent.abortRun后就返回，并不等待pi idle。
因此必须把adapter取消传播到session.abort，直到waitForIdle/完整settled之后才允许下一轮。重复stop不应崩溃或启动新工作。
SSE断开首期选择取消；模型/provider长时间不响应abort时需超时隔离处理，不能把会话标为ready但实际上仍在执行。

证据：

- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/chat.tsx:449
- /Users/yaotutu/Desktop/code/openmuse/node_modules/@copilotkit/core/dist/index.mjs:687
- /Users/yaotutu/Desktop/code/openmuse/node_modules/@copilotkit/runtime/dist/v2/runtime/handlers/handle-stop.mjs:6
- /Users/yaotutu/Desktop/code/openmuse/node_modules/@copilotkit/runtime/dist/v2/runtime/runner/in-memory.mjs:437

## 4. 后续功能接口清单

以下不作为P1实现范围。响应类型沿用domain，不默认包裹成{data}，数组不改成{items,nextCursor}。当前客户端这些请求没有cursor分页。
表中的path参数只是占位，不是新命名。B为按需；C为样例/富线程。

### 4.1 Agent产品能力

| 标记 | Method / Path | 实际请求 → 响应 |
| --- | --- | --- |
| B | POST /api/agent/tasks | CreateTaskInput + requestId? → AgentTask |
| B | GET /api/agent/tasks/:id | 无 → {task,events,artifacts,files,browsers} |
| B | POST /api/agent/tasks/:id/control | {action:pause/resume/cancel/retry} → AgentTask |
| B | POST /api/agent/tasks/:id/input | {answer,fields?:Record<string,string或boolean>} → AgentTask |
| B | POST /api/agent/goals | {title,category,description,milestones:string[]} → Goal |
| B | POST /api/agent/goals/:id | UI发送{status:active/paused/completed} → Goal |
| B | POST /api/agent/goals/:id/milestones/:milestoneId | {done:boolean} → Goal |
| B | POST /api/agent/monitors | {title,url,condition:change/contains/price_below,value,intervalMinutes} → Monitor |
| B | POST /api/agent/monitors/:id/control | {action:pause/resume/stop/check} → Monitor |
| B | POST /api/agent/ideas/refresh | {} → Idea[] |
| B | POST /api/agent/ideas/:id | {action:accept/dismiss,prompt} → Idea |
| B | POST /api/agent/memories | {text,source:"User added in Apps"} → AgentMemory |
| B | POST /api/agent/memories/:id | {text} → AgentMemory |
| B | POST /api/agent/memories/:id/forget | {} → {ok:true} |
| B | POST /api/agent/identity | {name,tone:warm/concise/thoughtful,avatar:sky/sand/lilac,showChatUpdates:boolean} → AgentIdentity |
| B | POST /api/agent/notifications/:id/read | {} → AgentNotification |
| C | POST /api/agent/sample-page | {text} → {ok:true} |

CreateTaskInput：prompt、kind(agent/document/monitor/finance/plan)、input、可选title/goalId/milestoneId；原schema有默认值。requestId是route扩展，不是原domain字段。

来源索引：

- task create：/Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/agent-workspace.tsx:85
- task detail/control/input：/Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/agent-ui.tsx:297
- task结果卡：/Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/thread-artifacts.tsx:76
- goals：/Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/agent-ui.tsx:1339
- monitors：/Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/agent-ui.tsx:1508
- ideas：/Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/agent-ui.tsx:1045
- identity/memories：/Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/agent-ui.tsx:1750
- notification：/Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/background-updates.tsx:20
- domain与完整校验：/Users/yaotutu/Desktop/code/openmuse/packages/domain/src/agent.ts:135
- server routes：/Users/yaotutu/Desktop/code/openmuse/apps/server/src/engine/routes.ts:31

### 4.2 Mail / Calendar / Action / Files / Google（全部B）

| Method / Path | 实际请求 → 响应 |
| --- | --- |
| GET /api/drafts | 无 → (EmailDraft & {id,createdAt})[] |
| POST /api/drafts | EmailDraft + id? → EmailDraft & {id,createdAt} |
| GET /api/mail/threads/:threadId | 无 → Mail[]；threadId经URL编码 |
| POST /api/mail/import-attachment | {reference} → Artifact |
| GET /api/calendars | 无 → {id,name,timeZone,accessRole}[] |
| GET /api/calendar/events | query calendarId/timeMin/timeMax → CalendarEvent[] |
| POST /api/actions | ProposalInput → ActionProposal |
| POST /api/actions/:id/decide | {hash,decision:approve/deny} → ActionProposal |
| POST /api/files | multipart字段file（PDF） → Artifact |
| POST /api/files/:id/fill | {fields:Record<string,string或boolean>} → Artifact |
| POST /api/google/connect | {capability:read/write} → {url:string或null,connected?:boolean} |
| POST /api/google/disconnect | {} → {ok:true} |

EmailDraft：to/cc/bcc/subject/body/attachmentIds/threadId?/replyToMessageId?。
ProposalInput：email.send、calendar.create、calendar.update、calendar.delete联合类型。
EventDraft：calendarId/title/start/end/allDay/timeZone/location/description/attendees；update额外eventId；delete data={calendarId,eventId,title}。

来源索引：

- mail与actions：/Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/details.tsx:111
- drafts列表：/Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/screens.tsx:460
- calendar：/Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/screens.tsx:626
- files upload：/Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/screens.tsx:958
- files fill：/Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/details.tsx:763
- google：/Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/screens.tsx:1194
- 类型/schema：/Users/yaotutu/Desktop/code/openmuse/packages/domain/src/index.ts:71
- routes：/Users/yaotutu/Desktop/code/openmuse/apps/server/src/app.ts:165

原生上传使用FileSystem.uploadAsync并直接JSON.parse响应，需额外保证错误也是JSON。公开calendar events仅返回events，底层截断信息未传客户端。

### 4.3 Browser（全部B）

| Method / Path | 实际请求 → 响应 |
| --- | --- |
| POST /api/browsers | {url} → BrowserSession |
| GET /api/browsers/:id | 无 → BrowserSession |
| POST /api/browsers/:id/navigate | {url} → BrowserSession |
| POST /api/browsers/:id/reopen | UI发{url} → BrowserSession |
| POST /api/browsers/:id/close | {} → BrowserSession |
| POST /api/browsers/:id/import-downloads | {} → {files:Artifact[],failures:{name,message}[]} |

来源：

- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/screens.tsx:841
- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/browser-tool-card.tsx:65
- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/details.tsx:868
- /Users/yaotutu/Desktop/code/openmuse/apps/server/src/app.ts:295

下载导入可以部分失败，不可只看HTTP200认为全部成功。

### 4.4 Computer（全部B）

| Method / Path | 实际请求 → 响应 |
| --- | --- |
| GET /api/computer | 无 → ComputerSnapshot |
| POST /api/computer/start | {} → ComputerSnapshot |
| POST /api/computer/stop | {} → ComputerSnapshot |
| POST /api/computer/commands | {command,cwd} → ComputerCommand |
| GET /api/computer/desktop | 无 → {url} |
| GET /api/computer/files | query path → ComputerDirectory |
| POST /api/computer/files/read | {path} → {path,text} |
| POST /api/computer/files/write | {path,text} → {path} |
| POST /api/computer/files/mkdir | {path} → {path} |
| POST /api/computer/files/import | {fileId,path} → {path} |
| POST /api/computer/files/export | {path} → Artifact |

按需提供未配置快照的合法结构：

~~~json
{
  "enabled": false, "provider": "docker", "status": "unconfigured",
  "workspacePath": "/workspace", "network": "disabled", "commands": []
}
~~~

可另加message字符串；commands不能省略。

来源：

- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/computer.tsx:203
- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/computer-workspace.tsx:56
- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/computer-workspace.tsx:429
- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/desktop-tool-card.tsx:48
- /Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/desktop-stream.tsx:84
- /Users/yaotutu/Desktop/code/openmuse/packages/domain/src/computer.ts:1
- /Users/yaotutu/Desktop/code/openmuse/apps/server/src/computer-routes.ts:13

### 4.5 非fetch的资源契约（延后，但不能漏）

PDF content、browser preview/console、desktop screenshot/stream通过组件、iframe或外部浏览器读取。与普通JSON API不同，其中file content和browser preview/console现有服务端支持签名URL。
首期没有附件/浏览器/desktop，也不导入旧工具会话，所以不要求实现；以后做能力时必须连同资源URL与鉴权一起验收。
证据：/Users/yaotutu/Desktop/code/openmuse/apps/server/src/app.ts:137

## 5. 工具UI约束

OpenMuse针对下列名字注册专门renderer：search_mail、read_mail_thread、search_web、browse_web、use_desktop、present_choices、delegate_task、agent_status、create_goal、watch_page、remember_fact。

工具接入需AG-UI TOOL_CALL_START / ARGS / END / RESULT，assistant toolCall与tool result通过toolCallId关联。status尚未complete时卡片显示进行中。
pi read/bash等名字和结果不天然满足这些专门卡片的数据结构；P2增加一个通用renderer比伪装现有工具更稳妥。
证据：/Users/yaotutu/Desktop/code/openmuse/apps/mobile/src/chat.tsx:54

## 6. 本轮已确定 / 尚未验证

额外校验：5个JSON示例可解析；run输入示例与6个正常/错误AG-UI事件样例已通过本地@ag-ui/core 0.0.59 schema校验。这不是网络SSE或端到端测试。

已确定：本地源码中的请求路径、方法、启动条件、关键response结构，以及已安装SDK的info/run/stop协议。
未验证：新后端网络行为、实际SSE数据抓包、目标模型兼容性、取消最终完成、history投影、原生端网络与上传。

下一步验收物不是更多架构图，而是最小contract fixtures + 真实模型/SDK验证 + 原OpenMuse Web端联调。

## 7. P1 实现后的契约增量

- workspace.runtime 新增可选 serverOwnedHistory=true、textOnly=true；省略时旧客户端行为保持不变。
- serverOwnedHistory 模式下聊天 finally GET conversation 并 setMessages；不再全量 PUT assistant 历史。
- PUT conversation 保留：完全等于 canonical 投影时返回 ok；差异/陈旧快照返回 409；非法 message 返回 400。
- textOnly 模式隐藏附件、tasks/activity/computer/sidebar、个人资料操作、工具/后台面板和样例入口，只开放聊天。
- 仅开放 GET runtime info、POST default/run 和 POST default/stop/local-main；connect、富线程和其他操作返回 501。
- 一次只接受 canonical 用户序列加一条新 user，或最后 user 的重试；assistant/system/tool/context/forwardedProps 不成为 pi 历史或权限。
- 已完成最后 user 再提交只返回 MESSAGES_SNAPSHOT + RUN_FINISHED，不重复 provider 调用；失败重试不重复 user。
- `GET /api/agent/tasks/:id` 返回 OpenMuse TaskDetail 契约 `{task,events,artifacts,files,browsers}`；定时任务只投影真实的创建、最近控制和最近一次运行事实，空能力数组不会伪造文件/浏览器/审批数据。
- `POST /api/agent/tasks/:id/control` 支持 `pause/resume/cancel/retry`。暂停/取消只阻止未来调度，不中断已在运行的会话或回滚副作用；retry 只由用户显式触发一次。非法请求 400、任务不存在 404、忙或非法状态 409。
- `tools.presentation` 是服务端展示投影配置，不需要客户端改动：`hidden` 工具不发送整组 `TOOL_CALL_*` 或对应历史工具消息；`summary` 保留工具名/ID但只发送受控参数与结果。pi canonical JSONL 和模型上下文仍保留完整工具结果，不能把客户端 history snapshot 当作 pi 历史。
- 实时 AG-UI 与 GET/replay 的历史投影使用同一策略；工具结果按 toolCallId 关联，未知关联默认不透传正文。summary 不得破坏专用 `search_web` renderer 的 `{results,warnings,truncated}` schema。
- stop 等待 pi idle 后返回，HTTP 退订取消其拥有的 run。错误/停止终态为 RUN_ERROR，不再伪造 RUN_FINISHED。
- 登录 token 为持久签名的 24h token，重启可用，更换工作区访问密钥后旧 token 失效。
- 验证已通过本地 HTTP 模拟 endpoint + 真实 pi SDK 自动测试与 OpenMuse Web 手动联调；真实目标 endpoint 与原生端待验收。
