# Attachments, files, and approvals

This page distinguishes three easily confused concepts: attachments sent with a message, persistent workspace files on the server, and human approval before the model writes a file. Entry points and limits were checked against current source; source does not automatically equal a released APK. Follow the UI in your installed release.

## Prerequisites {#prerequisites}

- The phone is connected to the real server as described in [Quick Start](getting-started.md#connect-mobile-client).
- Attachment selection depends on the Android system file picker. Current mobile source does not support selecting attachments in the Web preview.
- Workspace files and approvals are inside the current space's session panel: from the 「聊天」 page, tap the session information area in the middle of the top bar, then switch to 「工作区」 or 「审批」.

## What Belongs Where {#what-belongs-where}

| Concept | Entry point | Ownership and use | Key boundary |
| --- | --- | --- | --- |
| Message attachment | 「+」 to the left of the chat input | Enters this space's chat history with the user message and is supplied to the model as untrusted data | Not a workspace file and has no readable or writable relative path; it does not automatically become a persistent file |
| Workspace file | Session panel 「工作区」 | Persistent server file in either the current space's private area or the shared area for all spaces | Manual text saves require a complete before/after preview; model access is constrained by workspace boundaries |
| Model file approval | Session panel 「审批」 | Temporary authorization for a model-initiated `write` create/overwrite or `edit` exact edit | Each operation is approved separately; approval covers one bound version and does not guarantee execution success |

Ordinary file tools can access only the current space's private workspace and the explicitly designated `shared/...` area. They have no parent-directory privilege and cannot use absolute paths, escape directories, or bypass boundaries with symlinks. The server does not provide `bash` to the model.

## Send Attachments {#send-attachments}

1. On the chat page, confirm the current space and that no reply is running and no submission is awaiting confirmation.
2. Tap 「+」 to the left of the input field. Its accessibility name is 「添加图片或文本附件」.
3. Select one or more local files in the system picker. The picker requests multiple selection; cancelling it does not modify existing drafts.
4. After returning to Pi Muse, attachments appear above the input field. Tap the remove icon on an item to remove it before sending.
5. Enter text and tap the send arrow, or send attachments only. An attachment-only message is still processed through a model request.

After a successful send, attachments are persisted with that message in the space's chat history and are sent to the configured external model service while that message is processed. The user message shows each attachment's name, size, and type. Images can be tapped for preview; text attachments show metadata only. Attachment content is marked as untrusted data, but this does not guarantee that the model is unaffected by that content. Before sending, do not include credentials or content you do not want to provide to that model service; after sending, continue to review model output and file approvals.

Limits:

- At most 4 attachments per message.
- All attachments together are limited to 8,388,608 bytes; each image attachment is also limited to that size.
- Text attachments together are limited to 100,000 bytes. Each must be non-empty, contain no NUL bytes, and be valid UTF-8. Image bytes must match a declared PNG, JPEG, GIF, or WebP type.
- A file name is at most 200 characters and cannot contain path separators or control characters.
- Common supported UTF-8 text or source formats include `txt`, Markdown, CSV, JSON, XML, YAML, JavaScript, TypeScript, Python, Go, Rust, Java, Kotlin, C/C++, C#, PHP, SQL, shell, CSS, HTML, and SVG. Images support only PNG, JPEG, GIF, or WebP. PDF, Word, Excel, and other binary documents cannot be parsed directly; convert them to a supported format and select them again. Other unsupported binary files are rejected.
- Message text is limited to 32,000 characters. Whether images are used for visual understanding depends on the configured model. Do not expect reliable image descriptions if it does not support image input.

## Manage Workspace Files {#manage-workspace-files}

1. Tap the session information area in the top bar to open the current session panel.
2. Switch to the 「工作区」 page.
3. Select the scope:
   - 「当前空间」: show and modify only this space's private files.
   - 「共享文件」: show shared files explicitly accessible to all spaces. Saving, editing, or deleting affects every space.
4. Tap a directory to enter it, tap 「上级」 to go up, or tap a file to open 「文件详情」.
5. Text files show their complete content. PNG, JPEG, GIF, and WebP can be previewed safely. Other binary files can only be inspected with 「下载到设备」.
6. Tap 「新建文本」 to create a file, or open a text file and tap 「编辑文本」 to modify it.

Manual creation and editing support UTF-8 text only, with complete content limited to 100,000 bytes. A new path is relative to the selected scope root; each path segment may contain only ASCII letters, numbers, `.`, `-`, and `_`, separated by `/`. If a directory exceeds 1,000 entries or reading a file exceeds 8 MiB, the server rejects the request instead of truncating the list or content.

### Download to Device {#download-to-device}

1. In the Android client, open the file detail and confirm that the complete file has been read. Download copies the content read at that moment; it does not represent a later server-side version.
2. Tap 「下载到设备」.
3. Choose a target directory in the system directory picker and follow the system prompt to allow Pi Muse access. The system picker scopes this permission to the selected directory; the app does not require an “all files” permission.
4. Return to Pi Muse and check the save result. A successful save shows the actual file name and confirms that it was written to the selected device directory; cancelling directory selection writes nothing.

If the selected directory already contains a file with the same name, the app only reports a conflict and does not overwrite the old file. Choose another directory, or first verify and move or rename the existing file in the system file manager. If the original name contains characters unsupported by the device, it is changed to a safe ASCII name and the page shows that result. If the directory provider forces a rename or same-name inspection fails, the download stops instead of guessing the target.

### Save or Delete {#save-or-delete-files}

1. After entering or replacing complete text in the editor, tap 「预览保存」.
2. Review 「保存前 · 全文」 and 「保存后 · 全文」 to the end, and confirm the scope and path at the top.
3. Tap 「确认保存」. On success, the file detail returns the content actually written by the server. Creating an existing file fails without overwriting it; editing a missing file also fails and does not create it.
4. To delete a file, open its detail, tap 「删除文件」, then tap 「确认删除文件」 in the confirmation card. Only regular files can be deleted; directories cannot.

Manual saves do not create model approval records. Their safety confirmation is the complete before/after preview in the 「工作区」 page. If a save or delete result is unknown, the page shows 「上次文件操作结果未明」 and provides 「回读核对」. Read the file back completely, compare it, and only then explicitly unlock. Submitting again after unlocking starts a new request.

Ordinary manual saves take effect as the last successful save; there is no automatic merging or version-conflict protection. Refresh and verify the complete current content before editing a shared file. Do not apply the model approval's file-version binding to manual saves.

::: danger Irreversible deletion
Deleting a regular workspace file immediately removes it and cannot be recovered from the app. Deletion in the shared scope affects every space. Check the scope and path before confirming.
:::

## Approve Model File Writes {#approve-model-file-writes}

For ordinary workspace files, `write` creates or completely overwrites a text file, and `edit` replaces one uniquely matched section of existing text; both require approval. The skill library's `skills.save` also requires per-file approval; see [skill maintenance in Configuration](configuration.md#file-write-approvals) for creating, editing, enabling, and reading skills. Model file reads do not require approval, and ordinary model replies do not have a generic human-approval gate. The following steps describe approvals for ordinary workspace files.

1. When the model requests `write` or `edit`, session state shows a waiting approval. Tap the session information area and open the 「审批」 page.
2. Tap the pending item to view details. A decision is possible only after the complete preview is loaded; buttons remain unavailable while details are synchronizing.
3. Check:
   - Scope: current-space private file or shared file.
   - Path and kind: create, overwrite, or exact edit.
   - The ends of both 「修改前全文」 and 「计划写入全文」. Do not rely on the title or summary.
4. Tap 「拒绝本次操作」 or 「批准本次操作」.
5. In the second confirmation, review the warning and tap 「确认拒绝」 or 「确认批准」.
6. Return to the approval details and check the status and 「执行回执」. Approved only means you authorized the operation; execution may still not commit because the file changed, authorization expired, the run was canceled, or writing failed.

The default waiting period is 5 minutes, fixed when the approval is registered; client polling cannot extend it. Approval binds the complete content, path, and file version registered at that time. Rejection, expiry, run cancellation, or a file change while waiting prevents that modification from being committed. Approval does not authorize another file, later modification, or a new version of the same path.

If the execution receipt is `unknown`, or you are unsure after stopping or disconnecting whether a file was written, read the target file completely in the 「工作区」 page and compare it with the approval preview. Do not immediately approve a new write or resend the request. Approval history keeps terminal records and execution receipts, but a historical preview does not mean its authorization remains valid.

## Limits and Troubleshooting {#limits-and-troubleshooting}

| Symptom | Check | Action |
| --- | --- | --- |
| Attachments cannot be selected | Whether you are in the Android client; whether a run or unconfirmed submission is active | Wait for the run to finish and synchronize; select local files with the Android system picker |
| Attachment sending fails | Count, size, UTF-8 validity, and actual image type | Fix the limits above and select again; a rejected attachment does not enter the draft |
| File not found | Whether the scope is 「当前空间」 or 「共享文件」 | Check scope and path, then refresh the directory; a read failure is not shown as an empty directory |
| Download unavailable | Whether you are in the Android client and whether the system picker was cancelled or access denied | The current Web preview cannot save to a device directory. On Android, choose a directory again and allow access when prompted |
| Same-name conflict | Whether the selected device directory already has a file with that name | The app never overwrites it. Choose another directory, or verify and move or rename the old file in the system file manager |
| Manual save fails | More than 100,000 bytes, invalid path, existing create target, or missing edit target | Fix content or path; use another path to create, and refresh the current file before editing |
| Approval buttons unavailable | Whether approvals are synchronizing, expired, or missing loaded details | Tap 「重新同步审批」 and reopen details; the model must request again after expiry |
| File unchanged after approval | Whether the execution receipt succeeded and whether the file changed meanwhile | Read the complete file first; do not repeatedly approve the old approval |
