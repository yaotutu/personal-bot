import { randomUUID } from "node:crypto";
import {
  type FeedbackTargetRole,
  type MessageComment,
  type MessageExecutionFact,
  type MessageFeedback,
  type MessageFeedbackDocument,
  type MessageFeedbackEvent,
  type MessageFeedbackRepository,
  type ProjectedMessageMetadata,
  type ProjectedMessage,
} from "./types.js";

export class MessageFeedbackDomainError extends Error {
  constructor(
    public code: "INVALID_INPUT" | "NOT_FOUND" | "SESSION_CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

export const normalizeComment = (rawText: string): string => {
  const text = rawText.trim();
  if (!text) throw new MessageFeedbackDomainError("INVALID_INPUT", "Comment cannot be empty");
  if (text.length > 4000) throw new MessageFeedbackDomainError("INVALID_INPUT", "Comment must be at most 4000 characters");
  return text;
};

export const projectFeedback = (
  document: MessageFeedbackDocument,
  messageId: string,
): MessageFeedback => {
  const reaction = document.events.findLast(
    (event): event is Extract<MessageFeedbackEvent, { type: "reaction_changed" }> =>
      event.type === "reaction_changed" && event.messageId === messageId,
  );
  const comments = new Map<string, MessageComment>();
  for (const event of document.events) {
    if (event.messageId !== messageId || event.type === "reaction_changed") continue;
    if (event.type === "comment_added") {
      comments.set(event.commentId, {
        id: event.commentId, text: event.text, createdAt: event.at, updatedAt: event.at,
      });
    } else if (event.type === "comment_edited") {
      const comment = comments.get(event.commentId);
      if (comment) {
        comment.text = event.toText;
        comment.updatedAt = event.at;
      }
    } else {
      comments.delete(event.commentId);
    }
  }
  return { reaction: reaction?.to ?? null, comments: [...comments.values()] };
};

const withEvent = (
  document: MessageFeedbackDocument,
  event: MessageFeedbackEvent,
): MessageFeedbackDocument => ({
  schemaVersion: 1,
  events: [...document.events, event],
});

/**
 * 每个 conversation 绑定一个反馈会话。执行事实从 PI adapter 实时读取；
 * 反馈事件独立持久化，不进入模型上下文，也不改变 PI 会话 revision。
 */
export const createMessageFeedbackSession = (input: {
  spaceId: string;
  sessionId: () => string;
  facts: () => readonly MessageExecutionFact[];
  repository: MessageFeedbackRepository;
}) => {
  let activeRunId: string | null = null;
  const currentSessionId = input.sessionId;
  const available = (fact: MessageExecutionFact) =>
    fact.feedbackAvailable && (activeRunId === null || fact.runId !== activeRunId);
  const guardSession = (sessionId: string) => {
    if (sessionId !== currentSessionId()) {
      throw new MessageFeedbackDomainError("SESSION_CONFLICT", "Feedback belongs to an old session");
    }
  };
  const facts = () => input.facts();
  const target = (messageId: string, sessionId: string): MessageExecutionFact & { role: FeedbackTargetRole } => {
    guardSession(sessionId);
    const fact = facts().find((item) => item.id === messageId);
    if (!fact || (fact.role !== "user" && fact.role !== "assistant")) {
      throw new MessageFeedbackDomainError("NOT_FOUND", "Message not found");
    }
    if (!available(fact)) {
      throw new MessageFeedbackDomainError("NOT_FOUND", "Message is not available for feedback");
    }
    return fact;
  };
  const append = async (
    messageId: string,
    sessionId: string,
    create: (document: MessageFeedbackDocument, role: FeedbackTargetRole) => {
      document?: MessageFeedbackDocument;
      feedback: MessageFeedback;
    },
  ) => {
    const fact = target(messageId, sessionId);
    return input.repository.update(input.spaceId, currentSessionId(), (document) => {
      const changed = create(document, fact.role);
      return { ...(changed.document ? { document: changed.document } : {}), result: changed.feedback };
    });
  };
  return {
    sessionId: currentSessionId,
    setActiveRun: (runId: string | null) => { activeRunId = runId; },
    async get(messageId: string, sessionId: string): Promise<MessageFeedback> {
      target(messageId, sessionId);
      return projectFeedback(await input.repository.read(input.spaceId, currentSessionId()), messageId);
    },
    async events(messageId: string, sessionId: string) {
      target(messageId, sessionId);
      return (await input.repository.read(input.spaceId, currentSessionId()))
        .events.filter((event) => event.messageId === messageId);
    },
    setReaction(sessionId: string, messageId: string, reaction: "like" | "dislike" | null) {
      return append(messageId, sessionId, (document, role) => {
        const feedback = projectFeedback(document, messageId);
        if (feedback.reaction === reaction) return { feedback };
        const next = withEvent(document, {
          id: randomUUID(), type: "reaction_changed", messageId, role,
          from: feedback.reaction, to: reaction, at: new Date().toISOString(),
        });
        return { document: next, feedback: projectFeedback(next, messageId) };
      });
    },
    addComment(sessionId: string, messageId: string, text: string) {
      const normalized = normalizeComment(text);
      return append(messageId, sessionId, (document, role) => {
        const next = withEvent(document, {
          id: randomUUID(), type: "comment_added", messageId, role,
          commentId: randomUUID(), text: normalized, at: new Date().toISOString(),
        });
        return { document: next, feedback: projectFeedback(next, messageId) };
      });
    },
    editComment(sessionId: string, messageId: string, commentId: string, text: string) {
      const normalized = normalizeComment(text);
      return append(messageId, sessionId, (document, role) => {
        const feedback = projectFeedback(document, messageId);
        const comment = feedback.comments.find((item) => item.id === commentId);
        if (!comment) throw new MessageFeedbackDomainError("NOT_FOUND", "Comment not found");
        if (comment.text === normalized) return { feedback };
        const next = withEvent(document, {
          id: randomUUID(), type: "comment_edited", messageId, role, commentId,
          fromText: comment.text, toText: normalized, at: new Date().toISOString(),
        });
        return { document: next, feedback: projectFeedback(next, messageId) };
      });
    },
    deleteComment(sessionId: string, messageId: string, commentId: string) {
      return append(messageId, sessionId, (document, role) => {
        const feedback = projectFeedback(document, messageId);
        const comment = feedback.comments.find((item) => item.id === commentId);
        if (!comment) throw new MessageFeedbackDomainError("NOT_FOUND", "Comment not found");
        const next = withEvent(document, {
          id: randomUUID(), type: "comment_deleted", messageId, role, commentId,
          text: comment.text, at: new Date().toISOString(),
        });
        return { document: next, feedback: projectFeedback(next, messageId) };
      });
    },
    async project<T extends ProjectedMessage>(messages: readonly T[]): Promise<T[]> {
      const executionFacts = new Map(input.facts().map((fact) => [`${fact.role}:${fact.id}`, fact]));
      const document = await input.repository.read(input.spaceId, currentSessionId());
      return messages.map((message) => {
        const fact = executionFacts.get(`${message.role}:${message.id}`);
        if (!fact || message.role === "tool") return message;
        const projected: ProjectedMessageMetadata = {
          createdAt: fact.createdAt,
          source: fact.source,
          runId: fact.runId,
          jobId: fact.jobId,
          notificationId: fact.notificationId,
          feedbackAvailable: available(fact),
        };
        return {
          ...message,
          metadata: projected,
          feedback: projectFeedback(document, message.id),
        } as T;
      });
    },
  };
};

export type MessageFeedbackSession = ReturnType<typeof createMessageFeedbackSession>;
