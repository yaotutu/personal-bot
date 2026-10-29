export type InformationSettings = {
  enabled: boolean;
  batchWindowSeconds: number;
};

export type InformationPreferences = {
  notes: string;
};

export type InformationInputItem = {
  source: string;
  externalId: string;
  content: string;
  title?: string;
  receivedAt?: string;
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
};

export const defaultInformationState = (): InformationState => ({
  schemaVersion: 1,
  settings: { enabled: false, batchWindowSeconds: 15 },
  preferences: { notes: "" },
  items: [],
  runs: [],
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
  instructions: string;
  enabledSkillTexts: string[];
  preferences: InformationPreferences;
  items: InformationInputView[];
  feedbackExamples: InformationFeedbackExample[];
};

export type InformationInputView = {
  id: string;
  source: string;
  externalId: string;
  title?: string;
  content: string;
  receivedAt: string;
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

export type InformationSubmittedResult = {
  decisions: InformationDecision[];
  notifications: Array<{ itemIds: string[]; text: string }>;
};

export type InformationModelResult =
  | { ok: true; result: InformationSubmittedResult }
  | { ok: false; error: "MODEL_REQUEST_FAILED" | "INVALID_MODEL_RESULT" | "CANCELLED" };
