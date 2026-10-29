export class InformationError extends Error {
  constructor(
    public code:
      | "INVALID_INPUT"
      | "CONFLICT"
      | "SPACE_NOT_FOUND"
      | "DISABLED"
      | "SPACE_PAUSED"
      | "BUSY"
      | "NO_PENDING"
      | "NOT_FOUND"
      | "SHUTDOWN",
    message: string,
  ) {
    super(message);
  }
}
