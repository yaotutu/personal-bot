# Long-term goals

This guide explains how to create, filter, update, and delete long-term goals in the mobile client, and how goals enter model context. It was checked against current server and mobile source; source inspection is not a live business test or a test of a released APK. Follow the UI and release notes of the version you installed.

## Purpose and Scope {#purpose-and-scope}

Long-term goals are global records and do not belong to a space. Active goals are reread before every turn and injected into the system prompt of all spaces, helping the model consider the goal, progress, and next unfinished milestone when planning or answering.

A goal itself does not execute a plan, create scheduled jobs, monitor pages, or call tools automatically. To perform work, explicitly delegate it in chat or create jobs and monitors separately as described in [Scheduled jobs, web monitors, and activity history](tasks-and-monitors.md).

## Prerequisites {#prerequisites}

- The phone is connected to the real server as described in [Quick Start](getting-started.md#connect-mobile-client).
- The goals interface is under the bottom 「目标」 tab. Viewing, creating, updating status, toggling milestones, and deleting do not depend on the current space.
- To let the model create, list, toggle, or change goal status in chat, keep the current space's `goal` skill enabled. Built-in skills are enabled by default.

## View and Filter Goals {#view-and-filter-goals}

1. Tap the bottom 「目标」 tab.
2. Filter by 「全部」, 「进行中」, 「已暂停」, 「已完成」, or 「已归档」.
3. Under 「排序」, choose 「更新时间」 or 「创建时间」, then tap 「升序」 or 「降序」. The default is newest first by update time.
4. Review a goal card's category, description, milestone completion count, each milestone's completion time, creation time, and update time.

The current page has no search box or category filter. A failed list read keeps the previous content and shows an error instead of presenting an empty list. If old data is reported, complete a successful refresh before writing.

## Create Goals {#create-goals}

1. On the bottom 「目标」 tab, tap 「新建」.
2. Enter the 「标题」. It is required, cannot contain only whitespace, and is limited to 160 characters.
3. Optionally enter a 「描述」 of at most 2,000 characters.
4. Optionally enter a 「分类」 of at most 40 characters; if left blank, the server saves `general`.
5. For initial milestones, enter one title per line in 「初始里程碑」. Each title is limited to 160 characters, with at most 30 milestones.
6. Tap 「保存目标」. On success, the form closes and the new goal appears as 「进行中」.

Before saving, you can tap 「取消新建目标」 to discard the form. Save is unavailable while the title is blank. If submission is interrupted or its result is unknown, the form is retained and locked rather than resent automatically.

## Update Status and Milestones {#update-status-and-milestones}

1. In a goal card's 「状态」 row, tap 「进行中」, 「已暂停」, 「已完成」, or 「已归档」.
2. Tap a milestone row to check or uncheck it. Completed milestones show their completion time; unchecking clears it.
3. Verify the list's status, milestone count, and update time after the change.

Setting a goal to 「已完成」 automatically checks every unfinished milestone. Changing it back to 「进行中」 or 「已暂停」 does not undo those check records. Conversely, checking every milestone does not automatically complete the goal; completion requires your explicit choice.

Neither the current mobile interface nor the chat goal tool can edit an existing goal's title, description, category, or milestone text, nor add or remove individual milestones. To change those details, first create the corrected goal, verify it, and then delete the old one.

## Delete Goals {#delete-goals}

1. Tap 「删除」 on a goal card.
2. In the 「确认删除此目标？」 card, verify the goal title.
3. Tap 「确认删除目标」, or tap 「取消删除目标」 to keep it.

::: danger Irreversible deletion
Deletion permanently removes the goal and all of its milestones; it cannot be recovered in the app. Deleting a goal does not delete chat history, workspace files, activities, scheduled jobs, or monitors.
:::

## Visible Results {#visible-results}

- A new goal is immediately saved as a global goal with the initial status 「进行中」.
- 「进行中」 goals enter model context in every space from the next turn; paused, completed, and archived goals are not injected.
- Milestone checks update the card count and change the progress and next unfinished milestone supplied in the next turn.
- Managing goals directly on the goals page does not automatically create chat messages or call a model and does not incur model costs. Using the `goal` tool in chat is still a model execution and incurs model-call costs.

## Limits and Troubleshooting {#limits-and-troubleshooting}

| Symptom | Check | Action |
| --- | --- | --- |
| A goal does not influence answers | Whether its status is 「进行中」 | Only active goals are injected into the next turn. Completed or archived goals are no longer supplied automatically. |
| You want to change goal details | Whether the goal already exists | Current source cannot edit its title, description, category, or milestone text. Create the corrected goal and delete the old one after verification. |
| All milestones are checked but the goal is not completed | The goal status | Milestones never complete the goal automatically. Explicitly change its status to 「已完成」. |
| Controls are unavailable | Whether the list is stale, a write is in progress, or a result is unknown | Refresh successfully first. For an unknown result, verify the list and then unlock manually. |
| A submission result is unknown | Whether the page shows 「提交结果待核对」 | Refresh the goal list, verify whether creation, status, milestone, or deletion took effect, then unlock. The app does not retry automatically. |
| Goals remain visible after switching spaces | Whether the goal is global | This is expected. Global goals affect all spaces, and deleting a space does not delete goals. |
