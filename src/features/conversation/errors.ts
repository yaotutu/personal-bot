/** 只有明确受控的会话错误可携带文案返回客户端。 */
export class ConversationError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const rejectConversation = (code: string, message: string): never => {
  throw new ConversationError(code, message);
};
