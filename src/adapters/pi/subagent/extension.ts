import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionFactory, type AgentToolResult, type AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_TOOL_NAME = "subagent";
export type SubagentRole = { name: string; description: string; systemPrompt: string; tools?: string[] };
export type SubagentResult = { agent: string; task: string; output: string; isError?: boolean };
export type SubagentRunner = (
  role: SubagentRole, task: string, signal: AbortSignal | undefined,
  update: (result: SubagentResult) => void,
  parentToolCallId?: string,
  subagentId?: string,
) => Promise<SubagentResult>;
type Details = { mode: "single" | "parallel" | "chain"; results: SubagentResult[]; denied?: boolean };

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const taskItem = Type.Object({
  agent: Type.String({ minLength: 1, description: "Role name from available agents." }),
  task: Type.String({ minLength: 1, description: "Self-contained instruction; child does not inherit parent conversation history." }),
}, { additionalProperties: false });

// Adapted from pi-coding-agent 1.3.0 examples/extensions/subagent/index.ts (MIT).
// Retain upstream single/parallel/chain execution semantics, chain {previous} substitution,
// concurrency (4), task limits (8), and output cap (50 KiB), but locally unify parameters
// into top-level required mode + tasks to avoid mixed-parameter ambiguity.
// CLI spawning/discovery/TUI are replaced by injected, permission-bounded SDK sessions.
export const subagentParameters = Type.Object({
  mode: Type.Union([
    Type.Literal("single"),
    Type.Literal("parallel"),
    Type.Literal("chain"),
  ], {
    description: "Execution mode: single (exactly 1 task), parallel (1-8 concurrent tasks), or chain (1-8 sequential tasks where {previous} inserts prior step output).",
  }),
  tasks: Type.Array(taskItem, {
    minItems: 1,
    maxItems: MAX_PARALLEL_TASKS,
    description: "Subagent tasks to execute (1-8 tasks). Single mode requires exactly 1 task. When multiple tasks are provided, mode must be 'parallel' or 'chain'.",
  }),
}, { additionalProperties: false });

const truncateOutput = (output: string) => {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= PER_TASK_OUTPUT_CAP) return output;
  let end = PER_TASK_OUTPUT_CAP;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}\n\n[Output truncated]`;
};

export const createSubagentTool = (roles: readonly SubagentRole[], run: SubagentRunner, queued?: (id: string, role: string) => void) => defineTool({
  name: SUBAGENT_TOOL_NAME,
  label: "Subagent",
  description: "Delegate self-contained work to subagents with isolated contexts. " +
    "Provide mode ('single' | 'parallel' | 'chain') and tasks array (1-8 tasks). " +
    "Single mode requires exactly 1 task; parallel runs tasks concurrently; chain runs tasks sequentially where {previous} inserts prior step output. " +
    "Results return to you in this tool call, not a background queue. Use shared/... for shared materials; no arbitrary cwd. " +
    `Available agents: ${roles.map((role) => `${role.name}: ${role.description}`).join("; ")}`,
  parameters: subagentParameters,
  constrainedSampling: { type: "json_schema", strict: "prefer" },
  async execute(_id, params, signal, onUpdate): Promise<AgentToolResult<Details>> {
    const mode = params.mode;
    const reject = (text: string): AgentToolResult<Details> => ({
      content: [{ type: "text", text }],
      details: { mode, results: [], denied: true },
      isError: true,
    });
    if (mode === "single" && params.tasks.length !== 1) {
      return reject("Single mode requires exactly one task. For multiple tasks, set mode to 'chain' (sequential) or 'parallel' (concurrent).");
    }
    const missing = params.tasks.find((request) => !roles.some((role) => role.name === request.agent));
    if (missing) {
      return reject(`Unknown agent role. Available agents: ${roles.map((role) => role.name).join(", ")}`);
    }

    const requests = params.tasks;
    const childIds = requests.map(() => `subagent-${randomUUID()}`);
    requests.forEach((request, index) => queued?.(childIds[index], request.agent));
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
        }, _id, childIds[index]);
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
      if (results.filter(Boolean).length !== requests.length) {
        return {
          content: [{ type: "text", text: "Subagent execution failed." }],
          details: { mode, results },
          isError: true,
        };
      }
    } else {
      let previous = "";
      for (let index = 0; index < requests.length; index++) {
        const task = mode === "chain" ? requests[index].task.replace(/\{previous\}/g, () => previous) : requests[index].task;
        const result = await runOne(index, task);
        if (result.isError) return {
          content: [{ type: "text", text: mode === "chain" ? `Chain stopped at step ${index + 1}: ${result.output}` : result.output }],
          details: { mode, results },
          isError: true,
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

export const createSubagentExtension = (roles: readonly SubagentRole[], run: SubagentRunner, queued?: (id: string, role: string) => void): ExtensionFactory =>
  (pi) => { pi.registerTool(createSubagentTool(roles, run, queued)); };
