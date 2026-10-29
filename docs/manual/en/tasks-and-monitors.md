# Scheduled jobs, web monitors, and activity history

This guide explains how to create and manage Pi Muse scheduled jobs and web monitors, and how to review activity history explicitly registered by the model. It was checked against current server and mobile source; source inspection is not a live business test or a test of a released APK. Follow the UI and release notes of the version you installed.

## Purpose and Scope {#purpose-and-scope}

- **Scheduled job**: At the scheduled time, Pi Muse submits the job text as a user message to the origin space's current conversation and starts a real model run. It suits one-off reminders or work that must run at a fixed time every day.
- **Web monitor**: The server periodically fetches one public HTTP(S) page and notifies the origin space when its content changes or when a keyword changes from “not matched” to “matched.”
- **Activity history**: A timeline of composite or long-running work explicitly registered by the model during real execution. It is not a collection of every chat, every tool call, or every background notification.

All three areas are under the bottom 「任务」 tab. The session panel's 「历史」 page also shows activity history for the current space, but it does not provide the all-spaces scope switch shown in the main tasks page.

## Prerequisites {#prerequisites}

- The phone is connected to the real server as described in [Quick Start](getting-started.md#connect-mobile-client) and uses the Android client matching current source.
- The server must keep running. By default it scans scheduled jobs every 30 seconds and web monitors every 60 seconds. A one-time job that expires while the service is stopped is not caught up; a daily job recalculates the next future time.
- Creating a scheduled job in chat requires the current space's `cron` skill; creating a web monitor requires the `monitor` skill. Built-in skills are enabled by default. If one was disabled, re-enable it in space settings first.
- When a scheduled job fires, it calls the configured external model and may call tools, trigger file approvals, and incur model costs. Web monitors require web tools to be enabled and access only public HTTP(S) content.

## View Activity History {#view-activity-history}

1. Tap the bottom 「任务」 tab and keep 「活动历史」 selected in 「任务内容」.
2. Choose 「全部空间」 or 「当前空间」. When entered from the bottom 「任务」 tab, the default scope is 「全部空间」.
3. If the list already has activities, filter by 「全部」, 「执行中」, 「等待审批」, 「等待补充信息」, 「等待明确继续」, 「已完成」, 「执行失败」, 「已停止」, or 「执行中断」.
4. Tap an activity to inspect its goal, deliverable, progress, result, and execution steps. Steps are safe projections recorded by the server for events such as model calls, tools, subagents, approvals, and file commits; they do not contain the model's internal reasoning or raw tool payloads.
5. Tap 「加载更多」 when more history is available. The list is always ordered newest first by creation time. There is no separate manual refresh button; reopening the page, changing a filter, returning the app to the foreground, or receiving a relevant state change triggers a fresh read.

Ordinary answers, explanations, clarifications, and simple lookups usually do not create activities. `awaiting_continuation` means the previous run ended but the work is unfinished and you must explicitly ask to continue on the chat page. A service restart or interruption may show 「执行中断」. Activities are removed when their origin space is deleted.

## Create Scheduled Jobs {#create-scheduled-jobs}

1. On the chat page, open the space sidebar and confirm the current space. The job binds to this origin space. Resetting that space's conversation keeps the job by default and rebinds it to the new conversation; deleting the space deletes the job.
2. State the job content and its one-time or daily time directly in a message. For example: “Create a daily job at 09:00 to summarize today's todo items” or “Create a one-time job tomorrow at 09:00 Shanghai time to remind me to review the checklist.”
3. Send the message and wait for the model to call the `schedule` tool. A successful tool result shows a short job ID and the next execution time.
4. Open bottom 「任务」 → 「定时任务」 and verify its status, time, origin space, and next execution.

The current mobile client has no “new scheduled job” form. If the model only replies in text without calling the tool, explicitly ask it to create the scheduled job or check whether the `cron` skill is enabled. Do not treat a natural-language promise in chat as a scheduled job.

A one-time time must include an explicit timezone. When editing in the mobile app, it generates a timestamp with an offset from the phone's local date and time. A daily job stores only `HH:mm`, interpreted in the server's local timezone; the page shows that timezone as read from `/api/health`.

## Manage Scheduled Jobs {#manage-scheduled-jobs}

1. Tap bottom 「任务」 → 「定时任务」.
2. Filter with 「全部空间」 or 「当前空间」, sort by 「下次执行」, 「更新时间」, or 「创建时间」, and switch ascending or descending order.
3. Tap a job to open its detail and review the complete job text, latest result, origin space, job ID, and timeline.
4. Tap 「编辑定时任务」 to change the job text and its one-time/daily time. After trimming leading and trailing whitespace, the text must be non-empty and at most 2,000 characters. Saving changes only this job, does not change its origin space, and the page cannot modify the origin space.
5. Use 「暂停调度」, 「恢复调度」, 「取消任务」, 「立即重试」, or 「删除任务」 according to the state. Each operation first shows a confirmation card; check the job ID before confirming.

Control semantics:

| Action | Actual effect |
| --- | --- |
| Pause scheduling | Stops only future triggers; it does not stop a run already executing. |
| Resume scheduling | Restores only a paused job. An expired one-time job cannot be resumed; create a new one. |
| Cancel job | Stops the original schedule. It is not the stop button for a chat run that is currently executing. |
| Retry now | Available only for a failed job. Confirmation starts one real model run, which may use tools and approvals and incur costs; it is not repeated automatically. |
| Delete job | Permanently removes this job and its page timeline and cannot be recovered in the app. The origin space is not deleted. |

The job timeline contains creation, the latest control, and the latest run result; it is not complete chat history. While a job is running or queued, this management page cannot change its schedule; wait for that run to finish before managing it. To stop a run that is currently executing, go to the origin space's chat page, stop it there, and read back the result.

## Create and Control Web Monitors {#create-and-control-monitors}

1. On the chat page, confirm the current space. Monitor notifications are delivered to this origin space, and deleting the space deletes its bound monitors.
2. Provide a public HTTP(S) URL, a trigger condition, and a check interval in a message. For example: “Monitor `https://example.com/product` and notify me when ‘restock’ appears; check every 5 minutes.”
3. There are only two trigger conditions: `change` means the content fingerprint changes; `contains` means a specified keyword changes from “not matched” to “matched.” `contains` requires a keyword.
4. The interval is in minutes, with a minimum of 5 and a default of 30. If no title is provided, the URL becomes the title.
5. Send the message and wait for the model to call the `monitor` tool, then verify status, condition, accumulated checks, and origin space under bottom 「任务」 → 「网页监控」.

For `change`, the first check only establishes a baseline and does not notify; later fingerprint changes do. For `contains`, continued matches do not repeat notifications—only “not matched” changing to “matched” does. Page excerpts in monitor notifications are untrusted external content and should only be used as factual clues to verify.

Management steps:

1. On 「网页监控」, filter with 「全部空间」 or 「当前空间」 and sort by creation time, latest check, or status.
2. 「暂停」 stops future checks and 「恢复」 restores a paused monitor. These two actions submit immediately, so check the target card before tapping.
3. 「停止」 shows a confirmation card. Stopping is a terminal state and cannot be reversed; to continue monitoring, create a new monitor in chat.
4. 「删除」 also shows a confirmation card and permanently removes the monitor along with future checks and notifications. A stopped monitor can still be deleted from the list.

The current mobile client has no monitor edit form and cannot change its URL, keyword, interval, or origin space on this page. Pause/stop only controls future checks; neither starts an immediate check nor deletes an observed pending notification fact.

## Visible Results {#visible-results}

- After a scheduled job fires, the origin space's chat page receives a user message beginning with 「⏰ [定时任务]」 and starts a real model run. The job detail then shows the latest result, failed state, or next run time.
- When a monitor matches, the origin space receives a notification beginning with 「📡 [监控]」; the list updates accumulated checks, latest check, and latest notification time.
- Activity status and steps update from real execution. Failure, denial, cancellation, expiry, and interruption are preserved rather than disguised as success.

Because of the default scan periods, actual execution may start slightly after a job's due time or a monitor's interval. If a list says its data is stale or a write result is unknown, refresh and verify the state first; do not automatically resend the operation.

## Limits and Troubleshooting {#limits-and-troubleshooting}

| Symptom | Check | Action |
| --- | --- | --- |
| A job did not run at its time | Whether the server is running, the origin space is already running, or the scan is only slightly delayed | Wait for the next scan. An expired job waits while its conversation is busy. A one-time job missed during server downtime is not caught up. |
| A one-time job lost its execution opportunity after restart | Whether its time has expired | An expired one-time job is disabled without a catch-up run; create a new one if needed. A daily job recalculates the next future time. |
| A job failed | The latest result and error state in its detail | Failure is not rerun automatically. Verify the impact, then manually confirm 「立即重试」 or create a new job. |
| A daily time behaves unexpectedly | The server timezone shown on the page | Edit `HH:mm` in server time; do not convert it using the phone's timezone. |
| A monitor does not notify | Its condition, latest check, fetch error, and whether the server is running | `change` does not notify on the baseline check or unchanged content; `contains` does not repeat while a match continues. Fetch failures show an error instead of a fake notification. |
| Monitor fetching fails | Whether the URL is public HTTP(S), the page is reachable, and web tools are enabled | Fix the link or refresh later. The error remains until the next successful check. |
| An operation result is unknown | Whether the page shows 「提交结果待核对」 | Refresh the list and detail, verify the state or whether the item still exists, then manually unlock. The app does not retry automatically. |
| A chat is missing | Whether you are looking in 「活动历史」 | Activities contain only work explicitly registered by the model. Complete conversations are on the chat page and approvals are under 「审批」. |

Deleting a space also deletes that space's activity history and bound scheduled jobs and monitors, irreversibly. To clear only chat, use session reset in settings and choose on its confirmation card whether to clear jobs and monitors too.
