# Long-term memory and Dream

This page explains how to browse, search, create, edit, and delete global long-term memories in the mobile client, and how Dream consolidates conversations into profiles, space rules, or memories. Entry points and limits were checked against current mobile and server source; source capabilities do not automatically equal a released APK. Follow the UI in your installed release.

## Prerequisites {#prerequisites}

- The server is connected as described in [Quick Start](getting-started.md#connect-mobile-client), and 「长期记忆」 and 「Dream 记忆整理」 are available in Settings.
- Browsing, searching, and managing long-term memories only require server access. A Dream consolidation run also makes a real call to the external model configured on the server; if the model is missing or unavailable, the run fails.
- Long-term memories and the SOUL/USER profiles are global. Chat history, space rules, and Dream consolidation cursors are independent for each space.

## Manage Long-term Memories {#manage-long-term-memories}

1. Go to the bottom 「设置」 tab, then 「助手记忆」 → 「长期记忆」. The page opens with all memories; while loading, it says it is waiting for server memories.
2. The 「全部」 view shows at most 500 memories, newest by update time first. Each card shows the text, source, and update time.
3. Enter a keyword in 「搜索记忆关键词」 and tap 「搜索」 or the keyboard search action. Search is a case-insensitive substring match and returns at most 10 recently updated matches. The trimmed keyword can be at most 200 characters.
4. Tap 「全部」 to return to the full list, or 「刷新」 to reload the current view.
5. Tap 「新增记忆」, enter 1–2000 characters, and tap 「保存记忆」. Success shows 「记忆已新增」 and returns to the list. Items created in the mobile UI are labeled `Mobile UI`.
6. Tap 「编辑」 on a memory, change the text, and save. Success shows 「记忆已更新」, and the update time changes.
7. Tap 「删除」. The page shows the complete text before deletion. Confirming deletes it for every space and does not delete chat history; success shows 「记忆已删除」.

Deleting a long-term memory cannot be undone. After the total reaches 500 items, the server rejects new items; edit and merge or remove old items first. Do not save passwords, API keys, tokens, or other secrets as memories.

If a read fails, the page keeps the last observed content and reports that the latest state must be verified; changes are disabled. An interrupted or timed-out write may already have taken effect, so the page locks changes and asks you to reload 「全部」 first. After checking, tap 「已核对，解除提交锁定」 before deciding whether to submit another operation. The client does not automatically retry the write.

## Memory and Profile Boundaries {#memory-and-profile-boundaries}

| Content | Scope | When it reaches the model |
| --- | --- | --- |
| Long-term memory | Global, shared by all spaces | Not carried every turn; searched by keyword when it may matter |
| USER profile | Global, shared by all spaces | Injected as user profile from the next turn |
| SOUL profile | Global, shared by all spaces | Injected as assistant persona from the next turn |
| Assistant name and tone | Global, shared by all spaces | Effective from the next conversation turn after saving |
| Long-term goals | Global, shared by all spaces | Not automatically included in ordinary chat; spaces with the goal skill enabled can query and manage them on demand |
| Skill assets | One instance-level file set | Only skills enabled for the current space load on the next turn; a space stores only switch overrides |
| Shared workspace | Global | Accessed explicitly through `shared/...`; it does not appear in private-workspace searches |
| Information preference notes | Independent for each space | Read only by that space's information processing; Dream does not rewrite them into another preference store |
| Chat history | Independent per space | Used by that space's conversation; reset or space deletion clears it |
| Space rules | Independent per space | Effective from the next conversation turn after saving |

In a space with the memory skill enabled, you can explicitly ask the assistant to add, edit, or forget a fact. Whether that happened is determined by the actual tool result and can be checked here by refreshing and searching. A space with Dream enabled may also consolidate its chat separately. Message feedback does not automatically enter ordinary chat context and is not used for preference training; when information processing is explicitly enabled for a space, its background decision may read current feedback examples from that space. For editing SOUL/USER, see [Profile and settings](profile-and-settings.md#assistant-and-user-profile).

## Configure Dream {#configure-dream}

1. Go to bottom 「设置」 → 「助手记忆」 → 「Dream 记忆整理」. The page shows the global overview, global prompt, space selector, current space settings, latest run, and pending suggestions.
2. 「全局整理提示词」 is the shared base configuration for all spaces and can contain at most 20,000 characters. Saving it empty clears the custom override and uses the built-in default prompt. Tap 「查看内置默认提示词」 to inspect the default behavior.
3. Tap 「保存全局提示词」 after editing. Success shows 「全局 Dream 提示词已保存」. 「取消修改」 returns to the last successfully loaded value; 「清空草稿」 only clears the draft and has no effect until you save.
4. Tap an existing space under 「选择整理空间」. If the current space has unsaved periodic or supplemental prompt changes, switching requires confirming that its space draft will be discarded; the global draft is retained.
5. Under 「当前空间设置」, configure:
   - 「参加定期整理」: on by default for the main space and off for other spaces. Turning it off still allows manual consolidation.
   - 「继承全局提示词」: when on, the global prompt is combined with this space's supplemental prompt. When off, the space supplement takes precedence; if it is empty, the effective global prompt or built-in default is still used as the fallback.
   - 「本空间补充提示词」: at most 20,000 characters, only for this space. Saving an empty string clears the supplement.
6. Tap 「保存空间设置」. Success shows 「空间 Dream 设置已保存」.

Dream's fixed safety rules always apply and cannot be overridden by a global or space prompt: a consolidation run may only submit structured note proposals and has no file, network, browsing, or delegation tools. External content is not an instruction. Dream must not save credentials, record assistant guesses as user facts, or change permissions, tools, models, or configuration. 「本空间用途」 is read-only on the Dream page.

The fixed rules also describe data scope: USER, SOUL, and long-term memory are global targets. Only filtering rules, topic scope, sensitivity requirements, or format requirements caused by this space's purpose belong in this space's rules. Information-processing preference notes remain owned by their existing information entry and are not silently rewritten. A target being globally available does not make it suitable for every context; when a new fact's cross-space stability is unclear, it should enter the pending list. These are model classification instructions. The server enforces tool and approval boundaries, but cannot guarantee the real-world scope of every fact automatically; automatically written content can be checked in its pages afterward, while pending suggestions still require human confirmation.

The background check runs every 2 hours for spaces with periodic consolidation enabled. A check time is not a completion guarantee; spaces with an active conversation or an existing Dream run are skipped. Turning off periodic consolidation for a space affects future checks only and does not undo content already written.

## Run Dream Manually {#run-dream-manually}

1. On the Dream page, select a space and first save or discard both global and space changes. While a draft exists, 「立即整理当前空间」 is unavailable and the draft is not used for this model run.
2. Tap 「立即整理当前空间」. The request waits synchronously for the real model to finish; the client waits at most 300 seconds. You can continue using the app, but do not tap the button repeatedly.
3. Check the result:
   - 「已完成」 means the whole run succeeded and the cursor advances past the messages processed. With no new messages, it records zero processed messages and no changes.
   - 「部分完成」 means some targets or pending suggestions were written, but part failed. The cursor does not advance, so the next run rereads from the original position.
   - 「失败」 means the completed run was normally recorded with no writes, and the cursor does not advance. An interruption caused by a service restart must be checked as described below.
4. Review 「处理消息」 and 「实际变更」 to understand the scope. For a failed or partial run, the page shows the server's controlled error explanation.

Dream has no stop operation. Leaving the page, moving the app to the background, closing the app, or a client timeout only stops the phone from waiting; they do not stop or fail the remote consolidation. After returning, tap 「刷新」 to verify the latest run before running Dream again. A service restart changes a run left in the running state to failed; that failure marker does not mean earlier writes are absent and does not roll back completed writes. Read back USER/SOUL, space rules, long-term memories, and pending suggestions, verify them, then consolidate again instead of rerunning solely from the failed status.

Manual consolidation extracts messages after the last cursor and includes earlier overlapping context for understanding; the model is instructed to extract only from new messages. The main space may write global USER/SOUL directly. A global USER/SOUL suggestion from a non-main space enters the pending list. Writing space rules requires that space to have a purpose and should only collect preferences caused by that purpose. Editing or deleting an existing long-term memory requires its exact ID; if the model is unsure about the change, it should omit it rather than convert it into a pending addition. If a target changes concurrently, Dream skips overwriting it and reports failure or partial completion.

## Resolve Pending Suggestions {#resolve-dream-suggestions}

1. Under 「待决建议」, read the complete text, creation time, reason, and suggested target. A reason may be shown as 「归属不明确」 (unclear ownership), 「来自单一会话，但建议写入全局资料」 (a global profile suggestion from one session), or 「空间尚未设置用途」 (the space has no purpose).
2. Under 「实际应用到」, choose `USER`, `SOUL`, `规则`, or `记忆`. You do not have to keep the model's suggested target.
3. Tap 「应用到所选目标」, check the complete text and target in the confirmation, then tap 「确认应用」.
4. To avoid writing it, tap 「忽略建议」 and confirm dismissal.

Actual effects:

- `USER`: appends to the global user profile and affects every space.
- `SOUL`: appends to the global assistant persona and affects every space.
- `规则`: appends to the current space's rules and affects only that space; it fails if the space rule length limit is exceeded.
- `记忆`: always adds one global long-term memory and counts toward the 500-item limit; it is not used to confirm an edit or deletion. Uncertain edits/deletions of existing memories should be omitted at the proposal stage.
- 「忽略」 only removes that suggestion from the pending list and writes nothing. The chat transcript itself is not deleted.

After a successful apply, the pending item disappears immediately. The write is an append or a new memory; Dream does not rewrite it into a summary and does not provide a difference editor. You must manually confirm the complete text before applying. If the result is unknown, refresh and check both the list and target content before acting again; the client does not automatically retry.

## Reset and Delete Effects {#dream-reset-and-delete}

- 「重置当前会话」 clears that space's chat history, message feedback, Dream cursor, latest run, and pending suggestions. Its Dream switch, inheritance setting, supplemental prompt, space rules, and workspace files are retained. USER/SOUL, global memories, or space rules Dream previously wrote are not rolled back.
- Deleting a space also removes its chat history, message feedback, Dream configuration and consolidation state, pending suggestions, space rules, and bound jobs. Global USER/SOUL and global long-term memories already written are not removed.
- For steps, confirmations, and irreversible scope, see [Conversations and spaces](conversations-and-spaces.md#reset-and-delete-spaces).

## Limits and Failures {#limits-and-failures}

- If the Dream overview cannot be read or its state must be rechecked, saving, running, and pending decisions are disabled until you refresh.
- Only one Dream consolidation run can exist at a time. A manual run is rejected when the selected space has an active conversation, does not exist, or another Dream run is active.
- A missing model, failed model request, invalid proposal, concurrent modification, full memory capacity, or service shutdown can produce failure or partial completion. Already written parts are not automatically rolled back.
- The pending list keeps at most 50 deduplicated suggestions. Check the complete text before handling one, especially when changing the target to global USER, SOUL, or memory.
- Dream's scope classification relies on the model following its instructions. The server enforces tools, permissions, IDs, and main/non-main write rules, but code cannot prove that every fact is genuinely stable across real-life spaces.
- Content written by Dream affects subsequent model turns and does not rewrite already generated chat history.
