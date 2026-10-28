import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type Args = {
  baseUrl: string;
  tokenFile: string;
  contextFile: string;
  phase: "record" | "verify";
};

type Context = {
  spaceId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  commentId: string;
  revision: string;
  messageCount: number;
  eventCount: number;
};

type Feedback = {
  reaction: "like" | "dislike" | null;
  comments: Array<{ id: string; text: string; createdAt: string; updatedAt: string }>;
};

type Event =
  | { type: "reaction_changed"; messageId: string; from: "like" | "dislike" | null; to: "like" | "dislike" | null }
  | { type: "comment_added"; messageId: string; text: string }
  | { type: "comment_edited"; messageId: string; fromText: string; toText: string }
  | { type: "comment_deleted"; messageId: string; text: string };

const fail = (message: string): never => {
  throw new Error(message);
};

const parseArgs = (): Args => {
  const values = new Map<string, string>();
  let allowLive = false;
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--allow-live") {
      if (allowLive) fail("Duplicate --allow-live");
      allowLive = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[++index];
      if (!value || value.startsWith("--") || values.has(key)) fail(`Invalid or duplicate option: --${key}`);
      values.set(key, value);
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }
  if (!allowLive) fail("Explicit --allow-live is required");
  const baseUrl = values.get("base-url")!;
  const tokenFile = values.get("token-file")!;
  const contextFile = values.get("context-file")!;
  if (!baseUrl) fail("Explicit --base-url is required");
  if (!tokenFile) fail("Explicit --token-file is required");
  if (!contextFile) fail("Explicit --context-file is required");
  const phase = values.get("phase") ?? "record";
  const url = new URL(baseUrl);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username || url.password || url.search || url.hash
  ) fail("Invalid --base-url");
  if (phase !== "record" && phase !== "verify") fail("--phase must be record or verify");
  values.delete("base-url");
  values.delete("token-file");
  values.delete("context-file");
  values.delete("phase");
  if (values.size) fail(`Unknown option: --${[...values.keys()][0]}`);
  return { baseUrl: baseUrl.replace(/\/$/, ""), tokenFile, contextFile, phase: phase as Args["phase"] };
};

const args = parseArgs();
const token = (await readFile(args.tokenFile, "utf8")).trim();
if (!token) fail("Token file is empty");
let createdSpaceId: string | undefined;

const api = async (
  path: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<{ status: number; body: unknown; text: string }> => {
  const response = await fetch(`${args.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, text };
};

const expectStatus = async (label: string, status: number, expected: number, body?: unknown) => {
  if (status !== expected) {
    const detail = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body);
    fail(`${label}: expected HTTP ${expected}, got ${status}: ${detail}`);
  }
  console.log(`[PASS] ${label}`);
};

const feedbackPath = (spaceId: string, messageId: string, suffix = "") =>
  `/api/spaces/${encodeURIComponent(spaceId)}/messages/${encodeURIComponent(messageId)}/feedback${suffix}`;

const conversation = async (spaceId: string, requireSessionId = true) => {
  const result = await api(`/api/conversation?spaceId=${encodeURIComponent(spaceId)}`);
  await expectStatus(`GET conversation ${spaceId}`, result.status, 200, result.body);
  const body = result.body as {
    sessionId: string | null;
    revision: string;
    messages: Array<{
      id: string;
      role: string;
      metadata?: { source: string | null; feedbackAvailable: boolean };
      feedback?: Feedback;
    }>;
  };
  if (requireSessionId && !body.sessionId) fail(`Space ${spaceId} has no session`);
  return body;
};

const runModel = async (spaceId: string, prompt: string, ids: { runId: string; messageId: string }) => {
  const before = await conversation(spaceId, false);
  const result = await api("/api/conversation/run", {
    method: "POST",
    body: JSON.stringify({
      spaceId,
      runId: ids.runId,
      expectedRevision: before.revision,
      message: { id: ids.messageId, content: prompt },
    }),
  }, 300_000);
  await expectStatus(`real model run ${ids.runId}`, result.status, 200, result.body);
  const events = result.text.split("\n\n").flatMap((frame) =>
    frame.split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; messageId?: string }),
  );
  if (!events.some((event) => event.type === "RUN_FINISHED")) fail(`Model run ${ids.runId} did not finish`);
  const after = await conversation(spaceId);
  if (after.messages.length <= before.messages.length) fail("Real model run did not persist messages");
  console.log(`[PASS] real model persisted ${after.messages.length - before.messages.length} messages`);
  return after;
};

const assertAssistantAudit = (events: Event[], messageId: string) => {
  if (events.some((event) => event.messageId !== messageId)) fail("Raw events leaked another message target");
  if (events.map((event) => event.type).join(",") !==
    "reaction_changed,reaction_changed,reaction_changed,comment_added,comment_added,comment_edited,comment_deleted")
    fail("Raw assistant event sequence is incorrect");
  const reactions = events.filter((event): event is Extract<Event, { type: "reaction_changed" }> => event.type === "reaction_changed");
  if (
    JSON.stringify(reactions.map((event) => [event.from, event.to])) !==
    JSON.stringify([[null, "like"], ["like", "dislike"], ["dislike", null]])
  ) fail("Raw reaction transitions are incorrect");
  const added = events.filter((event): event is Extract<Event, { type: "comment_added" }> => event.type === "comment_added");
  if (added.map((event) => event.text).join("\n") !== "live comment one\nlive comment two")
    fail("Raw added comment text is incorrect");
  const edited = events.find((event): event is Extract<Event, { type: "comment_edited" }> => event.type === "comment_edited");
  if (edited?.fromText !== "live comment one" || edited.toText !== "live comment edited")
    fail("Raw edited comment old/new text is incorrect");
  const deleted = events.find((event): event is Extract<Event, { type: "comment_deleted" }> => event.type === "comment_deleted");
  if (deleted?.text !== "live comment two") fail("Raw deleted comment text is incorrect");
};

const setReaction = async (label: string, spaceId: string, sessionId: string, messageId: string, reaction: "like" | "dislike" | null) => {
  const result = await api(feedbackPath(spaceId, messageId, "/reaction"), {
    method: "PUT",
    body: JSON.stringify({ sessionId, reaction }),
  });
  await expectStatus(`${label} reaction ${reaction ?? "none"}`, result.status, 200, result.body);
  const feedback = result.body as Feedback;
  if (feedback.reaction !== reaction) fail(`${label} reaction response mismatch`);
};

const addComment = async (spaceId: string, sessionId: string, messageId: string, text: string) => {
  const result = await api(feedbackPath(spaceId, messageId, "/comments"), {
    method: "POST",
    body: JSON.stringify({ sessionId, text }),
  });
  await expectStatus(`add comment ${text}`, result.status, 200, result.body);
  return (result.body as Feedback).comments.at(-1)!;
};

const writeContext = async (context: Context) => {
  await mkdir(dirname(args.contextFile), { recursive: true, mode: 0o700 });
  await writeFile(args.contextFile, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
  console.log(`[PASS] wrote safe restart context ${args.contextFile}`);
};

try {
  if (args.phase === "record") {
    const stamp = Date.now();
    const spaceId = `feedback-live-${stamp}-${randomUUID().slice(0, 8)}`;
    createdSpaceId = spaceId;
    const userMessageId = `feedback-user-${stamp}`;
    const runId = `feedback-run-${stamp}-${randomUUID()}`;
    const first = await runModel(spaceId, "请直接简短回复 LIVE OK，不要调用工具。", { runId, messageId: userMessageId });
    const user = first.messages.find((message) => message.id === userMessageId && message.role === "user");
    const assistant = first.messages.find((message) => message.role === "assistant" && message.metadata?.source === "chat");
    if (!user?.metadata || !user.feedback || !assistant?.metadata || !assistant.feedback)
      fail("Real model history is missing required message metadata/feedback");
    const userMessage = user!;
    const assistantMessage = assistant!;
    if (userMessage.metadata!.source !== "chat" || assistantMessage.metadata!.source !== "chat" || !assistantMessage.metadata!.feedbackAvailable)
      fail("Real chat source or availability is incorrect");

    await setReaction("user", spaceId, first.sessionId!, userMessage.id, "like");
    await setReaction("user", spaceId, first.sessionId!, userMessage.id, "dislike");
    await setReaction("user", spaceId, first.sessionId!, userMessage.id, null);
    await setReaction("assistant", spaceId, first.sessionId!, assistantMessage.id, "like");
    await setReaction("assistant", spaceId, first.sessionId!, assistantMessage.id, "dislike");
    await setReaction("assistant", spaceId, first.sessionId!, assistantMessage.id, null);

    const firstComment = await addComment(spaceId, first.sessionId!, assistantMessage.id, " live comment one ");
    const secondComment = await addComment(spaceId, first.sessionId!, assistantMessage.id, " live comment two ");
    if (firstComment.text !== "live comment one" || secondComment.text !== "live comment two")
      fail("Server did not trim and persist multiple comments");

    const edit = await api(`${feedbackPath(spaceId, assistantMessage.id, `/comments/${firstComment.id}`)}`, {
      method: "PATCH",
      body: JSON.stringify({ sessionId: first.sessionId, text: "live comment edited" }),
    });
    await expectStatus("edit comment", edit.status, 200, edit.body);
    const edited = (edit.body as Feedback).comments.find((comment) => comment.id === firstComment.id)!;
    if (edited.text !== "live comment edited" || edited.updatedAt <= edited.createdAt)
      fail("Edited comment text or updatedAt is incorrect");

    const remove = await api(`${feedbackPath(spaceId, assistantMessage.id, `/comments/${secondComment.id}`)}?sessionId=${encodeURIComponent(first.sessionId!)}`, {
      method: "DELETE",
    });
    await expectStatus("delete comment", remove.status, 200, remove.body);
    if ((remove.body as Feedback).comments.some((comment) => comment.id === secondComment.id)) fail("Deleted comment remained current");

    const eventsResult = await api(`${feedbackPath(spaceId, assistantMessage.id, "/events")}?sessionId=${encodeURIComponent(first.sessionId!)}`);
    await expectStatus("read message-scoped raw events", eventsResult.status, 200, eventsResult.body);
    const events = (eventsResult.body as { events: Event[] }).events;
    assertAssistantAudit(events, assistantMessage.id);

    const afterFeedback = await conversation(spaceId);
    if (afterFeedback.revision !== first.revision || afterFeedback.messages.length !== first.messages.length)
      fail("Feedback changed PI revision or message count");

    await expectStatus(
      "unauthorized feedback is rejected",
      (await fetch(args.baseUrl + feedbackPath(spaceId, assistantMessage.id), { signal: AbortSignal.timeout(30_000) })).status,
      401,
    );
    const invalid = await api(feedbackPath(spaceId, assistantMessage.id, "/reaction"), {
      method: "PUT",
      body: JSON.stringify({ sessionId: first.sessionId, reaction: "meh" }),
    });
    await expectStatus("invalid reaction is rejected", invalid.status, 400, invalid.body);
    const missingMessage = await api(`${feedbackPath(spaceId, "missing-message")}?sessionId=${encodeURIComponent(first.sessionId!)}`);
    await expectStatus("missing message is rejected", missingMessage.status, 404, missingMessage.body);
    const missingSpace = await api(`${feedbackPath("feedback-live-missing", "missing")}?sessionId=${encodeURIComponent(first.sessionId!)}`);
    await expectStatus("missing space is rejected", missingSpace.status, 404, missingSpace.body);
    const crossSpaceConflict = await api(`${feedbackPath("local-main", assistantMessage.id)}?sessionId=${encodeURIComponent(first.sessionId!)}`);
    await expectStatus("cross-space session is rejected", crossSpaceConflict.status, 409, crossSpaceConflict.body);
    const localMain = await conversation("local-main", false);
    if (localMain.sessionId) {
      const crossSpaceTarget = await api(`${feedbackPath("local-main", assistantMessage.id)}?sessionId=${encodeURIComponent(localMain.sessionId)}`);
      await expectStatus("cross-space message is rejected", crossSpaceTarget.status, 404, crossSpaceTarget.body);
    } else {
      const wrongTarget = await api(`${feedbackPath(spaceId, "missing-cross-target")}?sessionId=${encodeURIComponent(first.sessionId!)}`);
      await expectStatus("missing message fallback is rejected", wrongTarget.status, 404, wrongTarget.body);
    }

    await writeContext({
      spaceId,
      sessionId: first.sessionId!,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      commentId: firstComment.id,
      revision: afterFeedback.revision,
      messageCount: afterFeedback.messages.length,
      eventCount: events.length,
    });
    console.log("[PASS] record phase complete; restart backend then run --phase verify");
  } else {
    const context = JSON.parse(await readFile(args.contextFile, "utf8")) as Context;
    const restarted = await conversation(context.spaceId);
    if (restarted.sessionId !== context.sessionId || restarted.revision !== context.revision || restarted.messages.length !== context.messageCount)
      fail("Restart changed session identity, PI revision, or persisted message count");
    const assistant = restarted.messages.find((message) => message.id === context.assistantMessageId);
    const comment = assistant?.feedback?.comments.find((item) => item.id === context.commentId);
    if (!comment || comment.text !== "live comment edited") fail("Restart lost persisted feedback");

    const eventsResult = await api(`${feedbackPath(context.spaceId, context.assistantMessageId, "/events")}?sessionId=${encodeURIComponent(context.sessionId)}`);
    await expectStatus("read events after restart", eventsResult.status, 200, eventsResult.body);
    const events = (eventsResult.body as { events: Event[] }).events;
    if (events.length !== context.eventCount)
      fail("Restart changed or leaked raw feedback events");
    assertAssistantAudit(events, context.assistantMessageId);

    const stamp = Date.now();
    await runModel(context.spaceId, "请再直接简短回复 LIVE VERIFY OK，不要调用工具。", {
      runId: `feedback-verify-${stamp}-${randomUUID()}`,
      messageId: `feedback-verify-user-${stamp}`,
    });

    const reset = await api(`/api/spaces/${encodeURIComponent(context.spaceId)}/reset`, {
      method: "POST",
      body: JSON.stringify({ clearSchedules: false }),
    });
    await expectStatus("reset live test space", reset.status, 200, reset.body);
    const newSessionId = (reset.body as { sessionId: string }).sessionId;
    if (newSessionId === context.sessionId) fail("Reset did not change sessionId");
    const oldSession = await api(feedbackPath(context.spaceId, context.assistantMessageId, "/reaction"), {
      method: "PUT",
      body: JSON.stringify({ sessionId: context.sessionId, reaction: "like" }),
    });
    await expectStatus("old session is rejected after reset", oldSession.status, 409, oldSession.body);

    const deleted = await api(`/api/spaces/${encodeURIComponent(context.spaceId)}`, { method: "DELETE" });
    await expectStatus("delete live test space", deleted.status, 200, deleted.body);
    const revived = await api(`${feedbackPath(context.spaceId, context.assistantMessageId)}?sessionId=${encodeURIComponent(newSessionId)}`);
    await expectStatus("deleted space feedback cannot revive", revived.status, 404, revived.body);
    console.log("[PASS] verify phase complete");
  }
} catch (error) {
  if (createdSpaceId && args.phase === "record") {
    await api(`/api/spaces/${encodeURIComponent(createdSpaceId)}`, { method: "DELETE" }).catch(() => undefined);
  }
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
