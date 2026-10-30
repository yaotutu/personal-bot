export class NewsError extends Error {
  constructor(
    public code: "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "REFRESHING" | "SHUTDOWN",
    message: string,
  ) {
    super(message);
  }
}
