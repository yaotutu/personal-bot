import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActionService } from "../../../features/actions/action-service.js";
import { guardPath } from "./path-guard.js";

/**
 * 写文件工具（write/edit）：与 read 同一 workspace 边界，但每次执行都要先过
 * 人工审批——工具内登记 pending action 并轮询（2s 间隔），批准才落盘，拒绝/
 * 超时返回受控失败。等待期间 pi 的 abort signal 会立即中断轮询。
 * 审批详情（写入内容/前后文本）随 action 存储，Web 展示 diff 预览。
 */
const MAX_BYTES = 100_000;
const POLL_INTERVAL_MS = 2_000;

const preview = (text: string, max = 800) =>
  text.length > max ? text.slice(0, max) + "…" : text;

const awaitApproval = async (
  actions: Pick<ActionService, "submit" | "poll">,
  kind: "file_write" | "file_edit",
  title: string,
  payload: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const action = await actions.submit(kind, title, payload);
  for (;;) {
    if (signal?.aborted)
      return { ok: false, reason: "Operation aborted while awaiting approval" };
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const decision = await actions.poll(action.id, timeoutMs);
    if (decision.status === "approved") return { ok: true };
    if (decision.status === "denied")
      return { ok: false, reason: "The user denied this write." };
    if (decision.status === "expired")
      return { ok: false, reason: "Approval timed out; nothing was written." };
  }
};

export const createWritableFileTools = (
  root: string,
  actions: Pick<ActionService, "submit" | "poll">,
  timeoutMs: number,
) => [
  defineTool({
    name: "write",
    label: "Write file",
    description:
      "Create or overwrite a text file inside the shared documents directory. " +
      "Every write requires explicit user approval before it happens; show the user what will be written. " +
      "Relative paths only (a leading / or .. is rejected). Max 100KB.",
    parameters: Type.Object(
      {
        path: Type.String({ description: "File path relative to the documents directory." }),
        content: Type.String({ description: "Full file content to write." }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal) {
      const target = guardPath(root, params.path);
      if (!target)
        return {
          content: [{ type: "text", text: "Access denied: path is outside the documents directory." }],
          details: { denied: true },
          isError: true,
        };
      if (Buffer.byteLength(params.content, "utf8") > MAX_BYTES)
        return {
          content: [{ type: "text", text: "File too large: writes are limited to 100KB." }],
          details: undefined,
          isError: true,
        };
      const verdict = await awaitApproval(
        actions,
        "file_write",
        `写入 ${params.path}`,
        { path: params.path, content: preview(params.content) },
        timeoutMs,
        signal,
      );
      if (!verdict.ok)
        return { content: [{ type: "text", text: verdict.reason }], details: undefined, isError: true };
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, params.content, "utf8");
      return {
        content: [{ type: "text", text: `Wrote ${params.path} (${params.content.length} chars).` }],
        details: undefined,
      };
    },
  }),
  defineTool({
    name: "edit",
    label: "Edit file",
    description:
      "Replace one exact text occurrence inside an existing file in the documents directory. " +
      "Requires explicit user approval; oldText must appear exactly once. Use write for whole files.",
    parameters: Type.Object(
      {
        path: Type.String({ description: "File path relative to the documents directory." }),
        oldText: Type.String({ description: "Exact existing text to replace." }),
        newText: Type.String({ description: "Replacement text." }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal) {
      const target = guardPath(root, params.path);
      if (!target)
        return {
          content: [{ type: "text", text: "Access denied: path is outside the documents directory." }],
          details: { denied: true },
          isError: true,
        };
      let original: string;
      try {
        original = await readFile(target, "utf8");
      } catch {
        return {
          content: [{ type: "text", text: `File not found: ${params.path}` }],
          details: undefined,
          isError: true,
        };
      }
      const count = original.split(params.oldText).length - 1;
      if (count === 0)
        return {
          content: [{ type: "text", text: "oldText not found in the file." }],
          details: undefined,
          isError: true,
        };
      if (count > 1)
        return {
          content: [{ type: "text", text: `oldText appears ${count} times; make it unique first.` }],
          details: undefined,
          isError: true,
        };
      const verdict = await awaitApproval(
        actions,
        "file_edit",
        `编辑 ${params.path}`,
        {
          path: params.path,
          oldText: preview(params.oldText, 400),
          newText: preview(params.newText, 400),
        },
        timeoutMs,
        signal,
      );
      if (!verdict.ok)
        return { content: [{ type: "text", text: verdict.reason }], details: undefined, isError: true };
      await writeFile(target, original.replace(params.oldText, params.newText), "utf8");
      return {
        content: [{ type: "text", text: `Edited ${params.path}.` }],
        details: undefined,
      };
    },
  }),
];
