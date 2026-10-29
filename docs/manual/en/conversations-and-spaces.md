# Conversations and spaces

This page covers daily chat, switching spaces, stopping runs, resetting a session, and deleting a space in the mobile client. Entry points and limits were checked against current mobile and server source; source does not automatically equal a released APK. Follow the UI in your installed release.

## Prerequisites {#prerequisites}

- The server is connected as described in [Quick Start](getting-started.md#connect-mobile-client), and the connection status is「已连接」.
- An external model is configured. If the model is not configured, chat messages are rejected.
- Distinguish the two panels: the menu at the upper left opens the space sidebar; the avatar, name, and status in the middle of the top bar open the current session panel.

## Send and Stop Conversations {#send-and-stop-conversations}

1. On the bottom「聊天」tab, confirm the current space. To change it, follow “Manage spaces” first.
2. Enter text in the「消息」input field. To send an image or text file with this message, use the「+」button described in [the attachment guide](files-and-approvals.md#send-attachments).
3. Tap the send arrow to the right of the input field. The visible success signal is your message entering the chat list and the header status changing to an executing state.
4. The reply streams into the page. When the model calls tools, progress appears in message tool cards or the session panel's「动态」view.
5. To stop, tap the same right-side button. While a run is active it appears as a stop square; if run status is still synchronizing, the button is unavailable. Tap「重新同步」first.

After a successful stop, the run changes to a stopped or terminal state. Stopping, leaving the chat view by switching spaces, disconnecting the chat stream, or restarting the service cancels the current chat run and invalidates unresolved file approvals. Tool operations that already completed are not rolled back.

A space permits one chat run at a time. If message ownership or history revision is unconfirmed, the client locks the send action. Tap「重新同步」and reconcile authoritative history; do not bypass the lock by repeatedly killing the app or resending.

## Manage Spaces {#manage-spaces}

1. Tap the menu at the upper left of the chat page to open the「你的空间」sidebar.
2. Tap any space to switch. The selected space is marked, and the chat page switches to its history, drafts, and run state.
3. Type a space ID in the「搜索空间」field to filter the list.
4. Tap the「新建空间」icon in the lower right. The client generates an ID beginning with `side-` and switches to it immediately.
5. Send the first message in the new space, or open the session panel and save its rules or skills to establish it on the server. Tapping「新建空间」without a write only creates a local empty entry on the phone and it may later disappear from the server list.

A space ID starts with a letter and contains only letters, numbers, `_`, and `-`, up to 64 characters. Current mobile source has no rename entry; create another space and move the required content if you need a different ID.

Each space has independent conversation history, a private workspace, space rules, and skill switches. Assistant identity, user profile, and long-term memory are global and are not isolated by space.

## Space Rules and Skills {#space-rules-and-skills}

1. Tap the session information area in the middle of the top bar to open the current session panel.
2. Switch to the「工作区」page.
3. Enter how the assistant should work in this space under「空间规则」, then tap「保存规则」. After a successful save, the loaded value updates. Rules take effect from the next turn and do not rewrite generated history.
4. Change switches under「空间技能」and tap「保存技能」. Switches affect only the current space.

Space rules are limited to 20,000 characters. Closing the panel keeps unsaved drafts for the current connection; changing servers or clearing local cache discards those local drafts.

## Reset and Delete Spaces {#reset-and-delete-spaces}

### Reset the Current Session {#reset-current-session}

1. Go to bottom「设置」→「会话维护」→「重置当前会话」.
2. Check the target space shown in the dialog.
3. By default, reset stops the current run, clears that space's chat history, message feedback, unfinished approvals, Dream consolidation cursor, and pending suggestions, then opens a fresh conversation. Space rules, skill switches, Dream configuration, and private workspace files are retained.
4. To also delete scheduled tasks and webpage monitors bound to the space, select「同时清理此空间下的定时任务与网页监控」. It is unselected by default; jobs and monitors are rebound to the new session.
5. Tap「确认重置」. Success shows「会话已重置」, and a new conversation can begin.

Cleared chat history and message feedback cannot be recovered. If the network result is unknown, the client keeps the unconfirmed state and pauses sending. Tap「核对重置结果」first; do not automatically retry the reset.

### Delete a Space {#delete-space}

1. In the space sidebar, switch to the non-main space you want to delete.
2. Tap the session information area in the top bar and open the session panel's「工作区」page.
3. Scroll to「删除当前空间」and tap it to open the confirmation card.
4. Check the deletion scope, then tap「确认删除」.

::: danger Irreversible deletion
Deleting a space permanently removes its chat history, message feedback, private workspace files, space rules, skill configuration, Dream configuration and consolidation state, and bound scheduled tasks and webpage monitors. The action cannot be undone and does not migrate data to the main space. The main space cannot be deleted. Use「重置当前会话」when you only want to clear the conversation.
:::

If a delete request result is unknown, refresh the space list and verify before resending. After deletion, creating a space with the same ID later does not restore the old history.
