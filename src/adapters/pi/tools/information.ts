import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { InformationError } from "../../../features/information/errors.js";
import type { InformationService } from "../../../features/information/service.js";

export const INFORMATION_TOOL_NAME = "information";

export const INFORMATION_TOOL_INSTRUCTIONS = [
  "Use information to answer user questions about this space's ingested information, processing runs, preferences and notification links.",
  "The tool is read-only, always available in ordinary chat, and scoped to the current space; it cannot ingest items, start runs, publish notifications, or access another space.",
  "Use overview for status questions, items/runs for bounded listings, item/run for one ID, or preferences for notes and current feedback examples.",
].join(" ");

type InformationToolResult = { error: string } | Record<string, unknown>;

const rejected = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: { denied: true },
  isError: true,
});

export const createInformationTool = (
  information: Pick<InformationService, "query">,
  spaceId: string,
) =>
  defineTool({
    name: INFORMATION_TOOL_NAME,
    label: "Information",
    description: INFORMATION_TOOL_INSTRUCTIONS,
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("overview"),
          Type.Literal("items"),
          Type.Literal("item"),
          Type.Literal("runs"),
          Type.Literal("run"),
          Type.Literal("preferences"),
        ]),
        status: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
        cursor: Type.Optional(Type.String()),
        itemId: Type.Optional(Type.String()),
        runId: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params): Promise<AgentToolResult<InformationToolResult>> => {
      try {
        const limit = params.limit === undefined ? undefined : Math.floor(params.limit);
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
          return rejected("limit must be an integer from 1 to 100.");
        }
        const result = await information.query({
          spaceId,
          action: params.action,
          status: params.status,
          limit,
          cursor: params.cursor,
          itemId: params.itemId,
          runId: params.runId,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: { result },
        };
      } catch (error) {
        if (error instanceof InformationError && error.code !== "SHUTDOWN") {
          return rejected(error.message);
        }
        throw error;
      }
    },
  });
