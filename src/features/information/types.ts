export type InformationSettings = {
  enabled: boolean;
  batchWindowSeconds: number;
  mode: "notifications" | "recommendations";
};

export type InformationPreferences = {
  notes: string;
  learnedNotes: string;
};

export type InformationInputItem = {
  source: string;
  externalId: string;
  content: string;
  title?: string;
  receivedAt?: string;
  metadata?: {
    sourceId: string;
    sourceTitle: string;
    url: string | null;
  };
};

export type InformationItemStatus = "pending" | "processing" | "processed" | "failed";

export type InformationItem = {
  id: string;
  spaceId: string;
  source: string;
  externalId: string;
  title?: string;
  content: string;
  receivedAt: string;
  acceptedAt: string;
  status: InformationItemStatus;
  runId?: string;
  metadata?: {
    sourceId: string;
    sourceTitle: string;
    url: string | null;
  };
};

export type InformationArticleFeedbackComment = {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
};

export type InformationArticleFeedback = {
  itemId: string;
  reaction: "like" | "dislike" | null;
  saved: boolean;
  comments: InformationArticleFeedbackComment[];
};

export type InformationDecision = {
  itemId: string;
  decision: "silent" | "notify";
  reason: string;
};

export type NotificationReceipt = {
  notificationId: string;
  sessionId: string;
  messageId: string;
};

export type InformationPublication = {
  notificationId: string;
  itemIds: string[];
  text: string;
  status: "pending" | "published" | "failed";
  receipt?: NotificationReceipt;
  error?: string;
};

export type InformationRunStatus = "running" | "completed" | "failed" | "cancelled";

export type InformationRun = {
  id: string;
  spaceId: string;
  itemIds: string[];
  status: InformationRunStatus;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  model?: {
    status: "succeeded" | "failed";
    error?: string;
  };
  decisions?: InformationDecision[];
  publications: InformationPublication[];
};

export type InformationState = {
  schemaVersion: 1;
  settings: InformationSettings;
  preferences: InformationPreferences;
  items: InformationItem[];
  runs: InformationRun[];
  articleFeedback: InformationArticleFeedback[];
};

export const defaultInformationState = (): InformationState => ({
  schemaVersion: 1,
  settings: { enabled: false, batchWindowSeconds: 15, mode: "notifications" },
  preferences: { notes: "", learnedNotes: "" },
  items: [],
  runs: [],
  articleFeedback: [],
});

export type InformationRepository = {
  read: (spaceId: string) => Promise<InformationState>;
  update: <T>(
    spaceId: string,
    change: (state: InformationState) => MaybePromise<{ state?: InformationState; result: T }>,
    options?: { allowCreate?: boolean },
  ) => Promise<T>;
  listSpaceIds: () => Promise<string[]>;
  removeSpace: (spaceId: string) => Promise<void>;
  reconcileOnStart: () => Promise<void>;
  validateAll: () => Promise<void>;
};

type MaybePromise<T> = T | Promise<T>;

export type InformationModelInput = {
  spaceId: string;
  runId: string;
  mode: "notifications" | "recommendations";
  instructions: string;
  enabledSkillTexts: string[];
  preferences: InformationPreferences;
  items: InformationInputView[];
  feedbackExamples: InformationFeedbackExample[];
  articleFeedback: InformationArticleFeedbackExample[];
};

export type InformationInputView = {
  id: string;
  source: string;
  externalId: string;
  title?: string;
  content: string;
  receivedAt: string;
  sourceTitle?: string;
  url?: string | null;
};

export type InformationFeedbackItemExample = {
  id: string;
  source: string;
  title?: string;
  content: string;
  contentTruncated: boolean;
};

export type InformationFeedbackExample = {
  runId: string;
  notificationId: string;
  text: string;
  reaction: "like" | "dislike" | null;
  comments: string[];
  commentsTruncated: boolean;
  items: InformationFeedbackItemExample[];
};

export type InformationArticleFeedbackExample = {
  id: string;
  title?: string;
  content: string;
  contentTruncated: boolean;
  reaction: "like" | "dislike" | null;
  saved: boolean;
  comments: string[];
};

export type InformationSubmittedResult = {
  decisions: InformationDecision[];
  notifications: Array<{ itemIds: string[]; text: string }>;
  learnedNotes?: string;
};

export type InformationModelResult =
  | { ok: true; result: InformationSubmittedResult }
  | { ok: false; error: "MODEL_REQUEST_FAILED" | "INVALID_MODEL_RESULT" | "CANCELLED" };
