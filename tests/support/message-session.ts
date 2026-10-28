import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDataLayout } from "../../src/adapters/storage/data-layout.js";
import { createMessageFeedbackRepository } from "../../src/adapters/storage/message-feedback-repository.js";
import { createMessageFeedbackSession, type MessageFeedbackSession } from "../../src/features/messages/service.js";
import type { MessageExecutionFact } from "../../src/features/messages/types.js";

/** 单元测试使用真实消息服务与文件 repository，只替换 PI facts 来源。 */
export const createMessageFeedbackFixture = async (input: {
  spaceId: string;
  sessionId: string;
  facts: () => readonly MessageExecutionFact[];
}): Promise<{ messages: MessageFeedbackSession; cleanup: () => Promise<void> }> => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-message-unit-"));
  const messages = createMessageFeedbackSession({
    spaceId: input.spaceId,
    sessionId: () => input.sessionId,
    facts: input.facts,
    repository: createMessageFeedbackRepository(createDataLayout(root)),
  });
  return { messages, cleanup: () => rm(root, { recursive: true, force: true }) };
};
