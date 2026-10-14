# 当前架构与新能力接入

> 2026-10-11：R0-R6 与 R7A 完成。保持单进程、单用户、单会话、单模型的模块化单体；目录使用 `features/`，不引入通用插件框架。

## 职责边界

| 位置 | 负责 | 不负责 |
| --- | --- | --- |
| `src/index.ts`、`scripts/dev-mock.ts` | 加载配置、HTTP 监听、信号退出 | 业务规则与工具实现 |
| `src/bootstrap/create-service.ts` | 创建唯一实例、注入依赖、调度启动、幂等 close | 客户端 DTO、agent loop |
| `src/config/` | 必需 JSON 配置文件、直接凭据与校验 | 初始化应用或存储业务 |
| `src/features/` | conversation、memory、identity、jobs、web、weather 的规则和最小 port | Hono、AG-UI、pi SDK、文件系统 |
| `src/adapters/pi/` | SDK session、历史、执行事件、prompt、工具 | 第二套历史或手写 agent loop |
| `src/adapters/ag-ui/` | runtime/runner、协议事件与取消适配 | 另一把会话锁 |
| `src/adapters/openmuse/` | 兼容路由、schema、presenter | 任务执行或存储所有权 |
| `src/adapters/storage/` | 原有路径、profile 文件、JSON reader/writer | 业务 CRUD 框架或在线迁移 |
| `src/adapters/web/` | 公网 HTTP(S)、DNS 校验与固定、搜索供应商、页面抓取 | 私网访问、浏览器执行或第二套 HTTP 安全规则 |
| `src/adapters/weather/` | Open-Meteo geocoding 与 forecast，复用安全 HTTP 边界 | 第二套 HTTP 安全规则或天气密钥持久化 |
| `src/http/` | CORS/body limit、公开接口、鉴权与路由挂载 | 创建业务实例或启动调度器 |
| `src/shared/` | 真正复用的基础函数，目前只有串行 writer | 收纳所有杂项的 utils 大文件 |

编译依赖：feature 依赖自身需要的内部类型/port；adapter 实现这些 port；bootstrap 同时知道双方并显式组装。HTTP 使用组合入口定义的依赖类型，但不会调用组合入口重新创建服务。

`tests/unit/dependencies.test.ts` 使用已有 TypeScript parser 检查 feature 的 import，禁止协议、SDK、文件系统和具体 adapter 依赖。仅允许现有业务生成 ID 使用 `node:crypto`，不增加 lint/DI 工具链。

## 状态与生命周期

- conversation service 是 active run/锁/取消原因的唯一所有者。客户端 run 与 scheduler trigger 共锁，但保留原有入口差异；trigger 不新增客户端超时或 SSE。
- pi SessionManager 是历史唯一权威来源。展示从完整 branch 投影，模型上下文仍交给 pi 的 compaction/context edit；不维护第二份 JSONL 或业务历史数据库。
- pi execution adapter 在 SDK 的 `message_end` listener 内清洗原 assistant 诊断，再交给 pi 持久化。不能只对 SSE 复制一份脱敏对象。
- memory 与 identity 共用一个 memory repository、一份 `memory.json` 和一个完整读改写队列；业务入口拆开不等于存储拆开。
- scheduler 负责固定 interval、tick 与 pending work；一个进程内只允许一个完整 tick 在途，候选任务执行前重读并检查 enabled/nextRunAt；状态保存失败时在内存保留同一次结果和完成时间，后续 tick 只补存，不重跑模型；close 同步停表，bootstrap 取消会话，再等已发出的调度与 markRun 完成，不为补存失败无限等待。
- 进程入口关闭 HTTP 监听并等待 service close；mock 入口还必须关闭 fake provider，包括配置/监听初始化失败时。

## 数据兼容与错误策略

本轮不迁移真实 DATA_DIR，不改变既有路径或 JSON 格式：

- memory：`{ memories: [...], identity: {...} }`，旧版缺省/局部 identity 使用默认值合并。
- jobs：裸数组 `[...]`。
- sessions/auth key/workspace/SOUL/USER/agent 路径由 `DataLayout` 集中声明，保持原位置；必需 `config.json` 由配置入口读取，不进入业务存储。

缺失文件返回初始化默认值；JSON 解析、根形状、已知 identity 字段类型错误与未知 `schemaVersion` 拒绝继续写。条目仍保留旧 reader 的 id/text、id/prompt 筛选语义，未趁重构强制补齐所有历史条目。

写入先在内存序列化，以 `wx`、`0600` 创建同目录 UUID 临时文件，完成后 `rename` 替换。失败尽量清理本次临时文件并保留原始错误；不承诺断电持久性，不做 fsync、跨进程锁、重试或恢复协议。

遇到损坏文档：停止服务、保留损坏原件，从有效备份恢复后再启动；不要直接删除文档“解决报错”。当前格式不变，代码回退不需要迁移数据，但旧代码的静默读错回空策略仍有风险。未来若引入格式版本，必须单独设计离线升级与数据回退。

## 调度启动与展示

- `createService` 在创建会话和启动 scheduler 前调用 `jobs.reconcileOnStart()`；按 nanobot 基线重新计算每日未来时刻，过期的一次性任务停用且不补跑。这覆盖旧 P4 的自然补跑规则，不改 JSON 形状。
- 正常运行期间主会话忙时保留到期任务，空闲后只执行一次；每轮结束后按结束时间计算 daily 下一轮，不逐日补齐，不自动重试失败的执行。
- OpenMuse task 的状态由调度开关和执行结果共同映射：一次性成功/失败保留 succeeded/failed；取消每日调度显示 cancelled，保留历史结果。

## 新能力最小接入流程

1. 判断是否有独立业务规则。若只有一个无状态只读工具，直接在 `adapters/pi/tools/` 实现；不要为了目录对称新增空壳 feature。
2. 有规则或持久化时，在 `features/<能力>/` 定义函数式 service 和实际需要的最小 port；文件读写放到 storage adapter，不在 feature 里 import fs。
3. 在 `adapters/pi/tools/index.ts` 显式装配工具。允许列表从注册结果生成，不再维护第二套名单；guard、参数 schema、受控错误与权限边界必须一起测试。
4. 确有 UI 管理入口时，新增对应 OpenMuse schema/routes/presenter；AG-UI 行为变化才修改其 adapter。复用现有通用工具卡片，不扩大客户端 patch。
5. 在 `bootstrap/create-service.ts` 创建共享实例并注入所需入口；新增同一文件 writer 时必须复用已有 repository，不能另建第二把锁。
6. 为纯规则写 unit tests，为 HTTP/pi/tool/history 行为写 integration tests；fake provider 分支放 `tests/support/fake-model.ts`。全部数据使用隔离临时目录。

工具增加不等于权限自动增加。网络工具、写文件、MCP 和委托任务各自需要独立权限设计，不能顺手打开 bash/edit/write。禁止目录扫描注册、事件总线、数据库/ORM、泛型 CRUD、durable execution 和自动重试。

## 验证入口与未验收范围

```sh
pnpm typecheck
pnpm test
pnpm build
```

当前 146 项测试通过；测试脚本显式运行 unit/integration 两个目录，任一目录未发现测试都会失败。已完成隔离 DATA_DIR 的编译进程/mock 进程健康、session、工具 SSE、SIGTERM、占用端口与非法配置退出检查。

重构结束后的第一阶段已独立修正基础 prompt，准确说明显式 memory/schedule 能力、只读文件权限和非实时提醒边界；新增 prompt 回归测试。隔离 DATA_DIR 的真实模型 HTTP/OpenMuse Web 核心复验已完成，包含一次实际超时及后续恢复；不把核心冒烟等同于穷尽验收。具体通过项、实际观察和未覆盖项见 `docs/first-stage-acceptance.md`。iOS/Android 仍未验收。
