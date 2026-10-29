# FAQ

This page starts from visible symptoms and low-risk checks. When the result of a write is unknown, verify the server state first instead of automatically resending. Current operation entry points are defined by [Quick Start](getting-started.md) and the two daily-operation guides.

## The Phone Cannot Connect to the Server {#phone-cannot-connect-to-server}

1. Visit `/api/health` from the server machine. If it fails, check the process and port first.
2. Verify that the phone's「服务器连接」address is the server base address, without `/api` or `/docs`.
3. On a LAN, enter the computer's actual IP and allow inbound port `17890` through its firewall.
4. If the status is「暂时不可用」, tap「重试连接」in「服务器连接」.

`localhost` on the phone refers to the phone itself and cannot reach a service on the computer.

## AccessKey Rejected {#access-key-rejected}

The client's「访问密钥」must contain `server.accessKey`, not `model.apiKey`. Check the configuration file actually read by that server. Changing or removing the AccessKey invalidates old Tokens, so the client must reauthenticate at the same address.

Never paste any key into public logs, screenshots, or issue reports.

## Test Passed but the Connection Was Not Saved {#test-passed-but-not-saved}

「测试通过，尚未保存」means the address and key work, but the configuration has not been written to the phone. Continue with「连接服务器」or「保存新地址」. The confirmation shown before changing addresses clears local business cache and old credentials; it does not delete remote data.

## No Model Reply {#no-model-reply}

Check that `model.baseUrl`, `model.id`, and `model.apiKey` all belong to the same usable model service, then review the server's controlled error. A failed model request is not retried automatically. If the previous turn may have performed a write or another tool operation, verify its actual result before sending again.

If the chat page shows「重新同步」, tap it to restore authoritative history and run status. Do not judge success solely from the last streaming frame.

## Stop or Disconnect State Is Unknown {#stop-or-disconnect-state-unknown}

Stopping cancels the current chat run and unresolved approvals, but completed tool operations are not rolled back. After stopping, leaving the chat view, or disconnecting, the client may show「执行结果待同步」or「消息保存状态待确认」.

For an ordinary chat stop, disconnect, or unknown message-save state, tap 「重新同步」 and wait for history and status synchronization before sending again. 「核对重置结果」 appears only when a reset is awaiting confirmation; do not treat it as the ordinary synchronization entry point. If the state remains unclear, see [Conversations and spaces](conversations-and-spaces.md#send-and-stop-conversations). For possible file writes, read the target file first.

## Attachment Rejected {#attachment-rejected}

Common causes are more than 4 attachments, total size over 8 MiB, text attachments over 100,000 bytes combined, an empty file, image bytes that do not match the declared type, or text that is not valid UTF-8. The system picker can read only local files returned by the picker.

For complete type and size limits, see [Attachments, files, and approvals](files-and-approvals.md#send-attachments). A rejected attachment is not added to the draft; fix the file and select it again rather than resending the whole conversation.

## File Modification Did Not Take Effect {#file-modification-did-not-take-effect}

Each model `write` or `edit` requires separate human approval. Rejection, expiry, a file change while waiting, run cancellation, unread approval details, or execution failure can prevent that commit. Approval also does not guarantee execution success. Check the complete preview and execution receipt under「审批」.

Manual workspace edits are confirmed in the save preview on the「工作区」page and do not create model approval records. If the result is unknown, read and verify it as described in [Attachments, files, and approvals](files-and-approvals.md#approve-model-file-writes); do not automatically resend the write.

## Reset or Delete Result Is Unknown {#reset-or-delete-result-unknown}

Reset and delete are destructive requests. A network error does not prove that the server did not execute them. The client keeps an unconfirmed notice and does not retry automatically. Refresh the space list and check the new session ID or whether the space disappeared before continuing.

Reset clears chat history and cancels unresolved approvals. Deleting a space also removes its workspace files, rules, skills, jobs, and monitors. Neither operation can be recovered. For the complete impact, see [Conversations and spaces](conversations-and-spaces.md#reset-and-delete-spaces).
