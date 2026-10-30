# Scheduled jobs, web monitors, and activity history

This guide explains the current mobile client entries for scheduled jobs, web monitors, and activity history. The bottom navigation is now 「News」 and no longer has the old 「Tasks」 aggregate page. Jobs and monitors remain server capabilities, but the current client manages them primarily through the `schedule` and `monitor` tools in chat. This page is checked against current server and mobile source; it is not a test of a released APK.

## Purpose and Scope {#purpose-and-scope}

- **Scheduled job**: At the scheduled time, Pi Muse submits the job text as a user message to the origin space's current conversation and starts a real model run.
- **Web monitor**: The server periodically fetches one public HTTP(S) page and notifies the origin space when content changes or a keyword changes from not matched to matched.
- **Activity history**: A timeline of composite work explicitly registered by the model during real execution. It is not a collection of every chat, every tool call, or every background notification.

The chat `schedule` and `monitor` tools list and control records only in the current space and do not accept a cross-space target. The server retains REST management capabilities for trusted clients or a later interface, but the current mobile client has no old bottom tasks page, all-spaces aggregate, job edit form, or separate monitor management page.

## Prerequisites {#prerequisites}

- The phone is connected to the real server as described in [Quick Start](getting-started.md#connect-mobile-client) and uses the Android client matching current source.
- The server must keep running. By default it scans jobs every 30 seconds and web monitors every 60 seconds. A one-time job that expires while the service is stopped is not caught up.
- Creating a job requires the current space's `cron` skill; creating a monitor requires the `monitor` skill. Re-enable either in space settings if it was disabled.
- Due jobs and monitor checks may access external networks and incur model costs. Monitors access only public HTTP(S), and fetched content is untrusted data.

## View Activity History {#view-activity-history}

1. Open the current space's session panel from the chat page.
2. Open the 「History」 page to see activities for that space.
3. If activities exist, filter by running, waiting for approval, waiting for input, awaiting continuation, completed, failed, stopped, or interrupted.
4. Open an activity to inspect its goal, deliverable, progress, result, and safe step projection. Steps do not contain internal model reasoning or raw tool payloads.
5. Load the next page when more records exist. The list is ordered newest first by creation time; reopening the page, changing a filter, returning the app to the foreground, or receiving a relevant state change triggers a fresh read.

The current client provides activity history only for the current space in the session panel. It does not provide the old tasks page's all-spaces scope. Ordinary answers, explanations, clarifications, and simple lookups usually do not create activities. `awaiting_continuation` means the previous run ended but the work is unfinished and requires an explicit request to continue in chat.

## Create and Control Scheduled Jobs {#scheduled-jobs}

1. Confirm the current space on the chat page. A job binds to this origin space. Resetting the space conversation keeps the job and rebinds it to the new conversation by default; deleting the space deletes the job.
2. State the job content and its one-time or daily time in a message. For example: “Create a daily job at 09:00 to summarize today's todo items” or “Create a one-time job tomorrow at 09:00 Shanghai time to remind me to review the checklist.”
3. Wait for the model to actually call the `schedule` tool. A successful result should include the job ID, state, and next execution time; a natural-language promise is not a scheduled job.
4. To inspect or control it, ask the model to use the `schedule` tool in the current space. The tool can list, pause, resume, cancel, delete, or retry jobs only in that space.

A one-time time must include an explicit timezone. A daily job uses `HH:mm`, interpreted in the server local timezone returned by `/api/health`, not the phone timezone. Pause stops future scheduling only; cancel is not the stop button for an executing chat run; retry starts one real model run for a failed job and does not automatically resend an unknown operation.

## Create and Control Web Monitors {#web-monitors}

1. Confirm the current space on the chat page. Notifications are delivered to this origin space, and deleting the space deletes bound monitors.
2. Provide a public HTTP(S) URL, trigger condition, and check interval in a message. For example: “Monitor `https://example.com/product` and notify me when ‘restock’ appears; check every 5 minutes.”
3. There are only two trigger conditions: `change` means the content fingerprint changes; `contains` means a specified keyword changes from not matched to matched and requires a keyword.
4. Wait for the model to actually call the `monitor` tool, then verify status, condition, accumulated checks, and origin space from the current space's tool result.
5. Inspect, pause, resume, stop, or delete through the current space's `monitor` tool. Stop is terminal; create a new monitor to continue.

For `change`, the first check only establishes a baseline and does not notify; later fingerprint changes do. For `contains`, continued matches do not repeat notifications—only a transition from not matched to matched does. Pause or stop affects future checks only; it does not start an immediate check or remove an already observed fact.

## Visible Results {#visible-results}

- After a job fires, the origin space's chat receives a user message beginning with 「⏰ [定时任务]」 and starts a real model run.
- When a monitor matches, the origin space receives a notification beginning with 「📡 [监控]」.
- Activity state and steps update from real execution. Failure, denial, cancellation, expiry, and interruption are preserved rather than disguised as success.

The default scan period means execution may start slightly later. If a tool result says the outcome is unknown, reread the current state before deciding whether to retry; do not automatically resend a write.

## Limits and Troubleshooting {#limits-and-troubleshooting}

| Symptom | Check | Action |
| --- | --- | --- |
| A job did not run at its time | Whether the server is running, the origin space is busy, or the scan is only slightly delayed | Wait for the next scan. A busy conversation delays the job. A one-time job missed during downtime is not caught up. |
| A one-time job did not run after restart | Whether its time expired | Expired jobs are not caught up; create a new one if needed. A daily job recalculates its next future time. |
| A job failed | Latest result and error state | Failure is not rerun automatically. Verify the impact, then retry manually through the current-space tool or create a new job. |
| A daily time behaves unexpectedly | Server timezone returned by `/api/health` | Enter `HH:mm` in server time; do not convert using the phone timezone. |
| A monitor does not notify | Condition, latest check, fetch error, and server state | `change` does not notify on the baseline or unchanged content; `contains` does not repeat while a match continues. |
| Monitor fetching fails | Whether the URL is public HTTP(S), reachable, and web tools are enabled | Fix the link or retry later. The error remains until the next successful check. |
| The old task aggregate page is missing | Bottom navigation is now 「News」 | Manage jobs and monitors through current-space chat tools; find activity history in the session panel's 「History」 page. |
| An operation result is unknown | Tool result and current-space state | Verify whether the record still exists and its state before retrying. Do not resend automatically. |

Deleting a space deletes that space's activity history, bound jobs, and monitors irreversibly. To clear only chat, use session reset and decide on its confirmation card whether to clear jobs and monitors too.
