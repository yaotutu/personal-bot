export type MessageSource = "chat" | "job" | "notification";
export type MessageReaction = "like" | "dislike";
export type FeedbackTargetRole = "user" | "assistant";

/** PI adapter 提供的执行事实；业务层不知道 SessionEntry 或 SDK 类型。 */
export type MessageExecutionFact = {
  id: string;
  role: FeedbackTargetRole;
  createdAt: string;
  source: MessageSource | null;
  runId: string | null;
  jobId: string | null;
  notificationId: string | null;
  /** PI adapter 判断消息是否已可安全反馈；当前 run 排除在业务层完成。 */
  feedbackAvailable: boolean;
};

export type MessageFeedback = {
  reaction: MessageReaction | null;
  comments: MessageComment[];
};

export type MessageComment = {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
};

export type MessageFeedbackEvent =
  | {
      id: string;
      type: "reaction_changed";
      messageId: string;
      role: FeedbackTargetRole;
      from: MessageReaction | null;
      to: MessageReaction | null;
      at: string;
    }
  | {
      id: string;
      type: "comment_added";
      messageId: string;
      role: FeedbackTargetRole;
      commentId: string;
      text: string;
      at: string;
    }
  | {
      id: string;
      type: "comment_edited";
      messageId: string;
      role: FeedbackTargetRole;
      commentId: string;
      fromText: string;
      toText: string;
      at: string;
    }
  | {
      id: string;
      type: "comment_deleted";
      messageId: string;
      role: FeedbackTargetRole;
      commentId: string;
      text: string;
      at: string;
    };

export type MessageFeedbackDocument = {
  schemaVersion: 1;
  events: MessageFeedbackEvent[];
};

export type MessageFeedbackRepository = {
  read: (spaceId: string, sessionId: string) => Promise<MessageFeedbackDocument>;
  update: <T>(
    spaceId: string,
    sessionId: string,
    change: (document: MessageFeedbackDocument) => { document?: MessageFeedbackDocument; result: T },
  ) => Promise<T>;
  removeSpace: (spaceId: string) => Promise<void>;
  validateAll: () => Promise<void>;
};

export type ProjectedMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
};

export type ProjectedMessageMetadata = {
  createdAt: string;
  source: MessageSource | null;
  runId: string | null;
  jobId: string | null;
  notificationId: string | null;
  feedbackAvailable: boolean;
};
