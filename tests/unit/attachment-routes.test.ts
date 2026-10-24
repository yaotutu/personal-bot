import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgUiRoutes } from "../../src/adapters/ag-ui/routes.js";
import type { ConversationHub } from "../../src/features/conversation/conversation-hub.js";
import type { ToolPresentation } from "../../src/adapters/ag-ui/tool-presentation.js";
import { runRequestSchema } from "../../src/http/contracts/rest.js";
import { validateConversationInput } from "../../src/features/conversation/validate-input.js";
import type { ConversationInput } from "../../src/features/conversation/types.js";

const routes = () => createAgUiRoutes(
  undefined as unknown as ConversationHub,
  undefined as unknown as ToolPresentation,
);

const imageBody = (size: number) => {
  const bytes = Buffer.alloc(size, 0);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const input: ConversationInput = {
    spaceId: "local-main",
    runId: "boundary-run",
    expectedRevision: "empty",
    message: {
      id: "boundary-user",
      content: "boundary",
      attachments: [{
        id: "boundary_image",
        name: "boundary.png",
        mimeType: "image/png",
        dataBase64: bytes.toString("base64"),
      }],
    },
  };
  return input;
};

const hubWithValidation = (
  history: Parameters<typeof validateConversationInput>[1],
  turns: Parameters<typeof validateConversationInput>[2]["turns"] = [],
) => ({
  forSpace: async () => ({
    validate: (input: ConversationInput) =>
      validateConversationInput(input, history, { turns, results: new Map() }, "empty"),
  }),
}) as unknown as ConversationHub;

test("run attachment route reports oversized JSON before starting SSE or a conversation", async () => {
  const body = Buffer.alloc(12 * 1024 * 1024 + 1, 97);
  const requestInit: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
  };
  // Node streaming Request 需要显式 half-duplex；这是测试传输细节，不进入业务协议。
  (requestInit as { duplex?: "half" }).duplex = "half";
  const response = await routes().fetch(new Request("http://local/api/conversation/run", requestInit));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: "Conversation request body exceeds 12 MiB",
    code: "REQUEST_TOO_LARGE",
  });
});

test("ordinary run validation failures use the controlled invalid input error code", async () => {
  const response = await routes().fetch(new Request("http://local/api/conversation/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { id: "user", content: "", attachments: [{ bad: true }] } }),
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Invalid conversation request",
    code: "INVALID_INPUT",
  });
});

test("an 8MiB canonical image passes schema and reaches identity validation without regex overflow", async () => {
  const input = imageBody(8 * 1024 * 1024);
  assert.equal(runRequestSchema.safeParse(input).success, true);
  const response = await createAgUiRoutes(
    hubWithValidation([], [{
      userId: "boundary-user",
      text: "different",
      runId: "boundary-run",
      assistantId: "assistant-boundary-run",
    }]),
    undefined as unknown as ToolPresentation,
  ).fetch(new Request("http://local/api/conversation/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, message: { ...input.message, content: "different" } }),
  }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Run ID was already used for another message",
    code: "RUN_ID_CONFLICT",
  });
});

test("one byte over the 8MiB total attachment limit is rejected before identity or model work", async () => {
  const input = imageBody(8 * 1024 * 1024 + 1);
  const response = await createAgUiRoutes(
    hubWithValidation([]),
    undefined as unknown as ToolPresentation,
  ).fetch(new Request("http://local/api/conversation/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Attachments exceed 8388608 total bytes",
    code: "INVALID_INPUT",
  });
});
