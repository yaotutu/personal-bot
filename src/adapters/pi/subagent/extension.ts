import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionFactory, type AgentToolResult, type AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_TOOL_NAME = "subagent";
export type SubagentRole = { name: string; description: string; systemPrompt: string; tools?: string[] };
export type SubagentResult = { agent: string; task: string; output: string; isError?: boolean };
export type SubagentRunner = (
  role: SubagentRole, task: string, signal: AbortSignal | undefined,
  update: (result: SubagentResult) => void,
  parentToolCallId?: string,
) => Promise<SubagentResult>;
type Details = { mode: "single" | "parallel" | "chain"; results: SubagentResult[] };

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const item = Type.Object({
  agent: Type.String({ minLength: 1 }),
  task: Type.String({ minLength: 1, description: "Self-contained instruction; child does not inherit parent conversation history." }),
}, { additionalProperties: false });

// Adapted from pi-coding-agent 1.3.0 examples/extensions/subagent/index.ts (MIT).
// Keep the upstream single/parallel/chain protocol, chain substitution, concurrency and output cap.
// CLI spawning/discovery/TUI are replaced by injected, permission-bounded SDK sessions.
export const subagentParameters = Type.Object({
  agent: Type.Optional(Type.String({ minLength: 1 })),
  task: Type.Optional(Type.String({ minLength: 1 })),
  tasks: Type.Optional(Type.Array(item, { minItems: 1, maxItems: MAX_PARALLEL_TASKS })),
  chain: Type.Optional(Type.Array(item, { minItems: 1, maxItems: MAX_PARALLEL_TASKS })),
}, { additionalProperties: false });

const truncateOutput = (output: string) => {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= PER_TASK_OUTPUT_CAP) return output;
  let end = PER_TASK_OUTPUT_CAP;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}\n\n[Output truncated]`;
};

export const createSubagentTool = (roles: readonly SubagentRole[], run: SubagentRunner) => defineTool({
  name: SUBAGENT_TOOL_NAME,
  label: "Subagent",
  description: "Delegate self-contained work to subagents with isolated contexts. " +
    "Choose exactly one mode: agent + task; tasks array (parallel); chain array (sequential, {previous} inserts prior output). " +
    "Results return to you in this tool call, not a background queue. Use shared/... for shared materials; no arbitrary cwd. " +
    `Available agents: ${roles.map((role) => `${role.name}: ${role.description}`).join("; ")}`,
  parameters: subagentParameters,
  async execute(_id, params, signal, onUpdate): Promise<AgentToolResult<Details>> {
    const modes = Number(Boolean(params.agent && params.task)) + Number(Boolean(params.tasks?.length)) + Number(Boolean(params.chain?.length));
    const mode: Details["mode"] = params.chain ? "chain" : params.tasks ? "parallel" : "single";
    const invalid = (text: string): AgentToolResult<Details> => ({
      content: [{ type: "text", text }], details: { mode, results: [] }, isError: true,
    });
    if (modes !== 1 || Boolean(params.agent) !== Boolean(params.task)) return invalid("Provide exactly one subagent mode.");
    const requests = params.chain ?? params.tasks ?? [{ agent: params.agent!, task: params.task! }];
    if (requests.length > MAX_PARALLEL_TASKS) return invalid(`Too many subagents (maximum ${MAX_PARALLEL_TASKS}).`);
    const missing = requests.find((request) => !roles.some((role) => role.name === request.agent));
    if (missing) return invalid(`Unknown agent. Available agents: ${roles.map((role) => role.name).join(", ")}`);
    const results: SubagentResult[] = [];
    const update: AgentToolUpdateCallback<Details> | undefined = onUpdate;
    const emit = () => update?.({
      content: [{ type: "text", text: `Subagents: ${results.filter(Boolean).length}/${requests.length} finished` }],
      details: { mode, results: results.filter(Boolean).map((result) => ({ ...result, output: truncateOutput(result.output) })) },
    });
    const runOne = async (index: number, task: string) => {
      signal?.throwIfAborted();
      const role = roles.find((candidate) => candidate.name === requests[index].agent)!;
      let result: SubagentResult;
      try {
        result = await run(role, task, signal, () => {
          // 仅报告进度，不把未结束的子会话原始消息/诊断塞入父会话。
          update?.({ content: [{ type: "text", text: `Subagent ${role.name} is working` }], details: { mode, results: results.filter(Boolean) } });
        }, _id);
      } catch {
        signal?.throwIfAborted();
        result = { agent: role.name, task, output: "Subagent execution failed", isError: true };
      }
      signal?.throwIfAborted();
      results[index] = { ...result, output: truncateOutput(result.output) };
      emit();
      return results[index];
    };
    if (mode === "parallel") {
      let nextIndex = 0;
      // 上游同样按输入顺序返回，最多四项同时运行；取消后不启动尚未开始的项。
      await Promise.allSettled(Array.from({ length: Math.min(MAX_CONCURRENCY, requests.length) }, async () => {
        while (nextIndex < requests.length) {
          const index = nextIndex++;
          await runOne(index, requests[index].task);
        }
      }));
      signal?.throwIfAborted();
      if (results.filter(Boolean).length !== requests.length) return invalid("Subagent execution failed.");
    } else {
      let previous = "";
      for (let index = 0; index < requests.length; index++) {
        const task = mode === "chain" ? requests[index].task.replace(/\{previous\}/g, () => previous) : requests[index].task;
        const result = await runOne(index, task);
        if (result.isError) return {
          content: [{ type: "text", text: mode === "chain" ? `Chain stopped at step ${index + 1}: ${result.output}` : result.output }],
          details: { mode, results }, isError: true,
        };
        previous = result.output;
      }
    }
    return {
      content: [{ type: "text", text: mode === "parallel"
        ? results.map((result) => `### [${result.agent}] ${result.isError ? "failed" : "completed"}\n\n${result.output}`).join("\n\n---\n\n")
        : results.at(-1)?.output || "(no output)" }],
      details: { mode, results },
      ...(results.some((result) => result.isError) ? { isError: true } : {}),
    };
  },
});

export const createSubagentExtension = (roles: readonly SubagentRole[], run: SubagentRunner): ExtensionFactory =>
  (pi) => { pi.registerTool(createSubagentTool(roles, run)); };
