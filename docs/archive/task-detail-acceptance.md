# OpenMuse Activity 任务详情闭环验收

日期：2026-10-12。

## 自动化

- `pnpm typecheck` 通过。
- `pnpm test`：176 项通过。
- `pnpm build` 与 `git diff --check` 通过。
- 新增 unit 覆盖：详情 DTO 五字段契约、稳定事件 ID、只读不写、legacy 状态、pause/resume/cancel/retry 状态矩阵、过期一次性任务、daily 重算、显式 retry 单次消费、控制与 markRun 顺序、重启 retry 清理、旧 jobs reader 兼容。
- 新增 integration 覆盖：HTTP 详情 200/404、控制 400/409、创建提醒→详情 scheduled→cancel→详情 cancelled；隔离 scheduler 的 pause 阻止执行、resume 后执行并进入 succeeded、cancel 阻止执行、失败态显式 retry 只执行一次、刷新/重启一致。

## Web DEV 实际验收

沿用运行中的真实模型服务和 OpenMuse Web DEV（8081），未修改客户端，也未创建新的正式任务：

1. 已完成的正式喝水任务打开详情页，原 `This feature is not implemented` 501 消失。
2. 详情显示真实任务标题、`Succeeded`、实际结果和 Timeline：
   - Task created
   - Latest run succeeded
3. `GET /api/agent/tasks/:id` 返回了完整的 `{task,events,artifacts,files,browsers}` 结构；空数组是诚实的，因为 personal-bot 没有 OpenMuse 原生 artifacts/files/browser 数据。
4. Activity 页的 Workspace timeline 仍显示空状态，这是预期的：当前 personal-bot 未实现 OpenMuse `actions/activity` 审批收据体系；定时任务属于上方 tasks 区域。

自动化隔离验证已经覆盖控制按钮和 scheduler 闭环。补充的隔离真实模型 Web API/DEV 验收：

- 通过真实模型服务配置的隔离实例创建了失败 fixture 和 scheduled fixture；没有复制或写入正式 `.personal-bot/` 数据。
- 测试前置失败快照通过 API 显式请求 Retry 后，由真实模型执行并成功；随后在 OpenMuse Web DEV 中打开该任务详情，显示 `Succeeded`、真实结果和三段 Timeline（created → retry requested → latest run succeeded），没有 501。失败 fixture 不等于供应商自然故障。
- 打开 scheduled 任务详情后点击 Cancel，立即显示 `Cancelled`，按钮消失，Timeline 追加 `Task cancelled`；该任务没有执行。
- 对重复 Retry 的 API 请求返回 409；第一次显式 retry 最终只执行一次并返回 `TASK-DETAIL-RETRY-OK`。
- 另一个隔离任务通过 Web 创建后由真实 scheduler 执行，API 确认 succeeded 和 `TASK-DETAIL-PAUSE-OK`。原定文本等待未匹配到预期文案，等待工具超时且浏览器重连；因此未完成 Pause/Resume 和 Retry 按钮本身的 Web 点击复验，不能用 API/自动化结果冒充这两项页面观察。

正式 Web 页面没有点击正式任务的 Pause/Cancel/Retry，避免改变用户实际任务；服务端仍在 8787 运行 DEV 热重载。
