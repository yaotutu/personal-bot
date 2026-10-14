import { useEffect, useState } from "react";
import { controlTask, createTask, getAgentSnapshot, type TaskView } from "../lib/api";

const kindLabel = (task: TaskView) =>
  (task as { kind?: string }).kind === "agent" ? "后台任务" : "定时";

const statusLabel: Record<string, { text: string; className: string }> = {
  scheduled: { text: "已排期", className: "bg-blue-50 text-blue-700" },
  running: { text: "执行中", className: "bg-amber-50 text-amber-700" },
  paused: { text: "已暂停", className: "bg-stone-100 text-stone-600" },
  succeeded: { text: "上次成功", className: "bg-green-50 text-green-700" },
  failed: { text: "上次失败", className: "bg-red-50 text-red-700" },
  cancelled: { text: "已取消", className: "bg-stone-100 text-stone-400" },
  queued: { text: "排队中", className: "bg-stone-100 text-stone-600" },
};

const formatTime = (iso?: string) => {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("zh-CN", { hour12: false });
};

/** 任务页：定时任务列表 + 状态与控制；新建任务直接在聊天里说“X 点提醒我 Y”。 */
export const JobsView = () => {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState("");
  const submit = async () => {
    try {
      await createTask(draft.trim());
      setDraft("");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    }
    reload();
  };

  const reload = () => {
    void getAgentSnapshot()
      .then((data) => setTasks(data.tasks))
      .catch((e: Error) => setError(e.message));
  };

  useEffect(reload, []);

  const act = async (
    id: string,
    action: "pause" | "resume" | "cancel" | "retry",
    target?: "job" | "task",
  ) => {
    setBusy(`${id}:${action}`);
    const result = await controlTask(id, action, target);
    setBusy("");
    if (!result.ok) setError(result.error ?? "操作失败");
    else setError("");
    reload();
  };

  const Button = ({
    id,
    action,
    label,
    danger,
    target,
  }: {
    id: string;
    action: "pause" | "resume" | "cancel" | "retry";
    label: string;
    danger?: boolean;
    target?: "job" | "task";
  }) => (
    <button
      disabled={busy.length > 0}
      onClick={() => void act(id, action, target)}
      className={`rounded-lg border px-2.5 py-1 text-xs disabled:opacity-40 ${
        danger
          ? "border-red-200 text-red-600 hover:bg-red-50"
          : "border-stone-300 text-stone-600 hover:bg-stone-50"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) void submit();
            }}
            placeholder="交给助手后台执行的活，如：总结 workspace 里的资料…"
            className="flex-1 rounded-lg border border-stone-300 px-3 py-1.5 text-sm outline-none focus:border-stone-500"
          />
          <button
            onClick={() => draft.trim() && void submit()}
            className="rounded-lg bg-stone-800 px-4 py-1.5 text-sm font-medium text-white"
          >
            创建
          </button>
        </div>
        <p className="text-xs text-stone-400">
          定时提醒在聊天里说“明天 9 点提醒我 …”；上面的输入框创建后台任务。
        </p>
        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>
        )}
        {tasks.length === 0 && !error && (
          <div className="rounded-2xl border border-dashed border-stone-300 py-12 text-center text-sm text-stone-400">
            还没有定时任务
          </div>
        )}
        {tasks.map((task) => {
          const badge =
            statusLabel[task.status] ?? {
              text: task.status,
              className: "bg-stone-100 text-stone-600",
            };
          const active = task.status === "scheduled" || task.status === "running";
          return (
            <div key={task.id} className="rounded-2xl border border-stone-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-stone-800">{task.prompt}</p>
                  <p className="mt-1 text-xs text-stone-400">
                    下次 {formatTime(task.nextRunAt)} · 更新 {formatTime(task.updatedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] text-stone-500">
                    {kindLabel(task)}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}
                  >
                    {badge.text}
                  </span>
                </div>
              </div>
              {task.result && (
                <p className="mt-2 line-clamp-3 whitespace-pre-wrap rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">
                  {task.result}
                </p>
              )}
              {task.error && (
                <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                  {task.error}
                </p>
              )}
              <div className="mt-3 flex gap-2">
                {(() => {
                  const isAsync = kindLabel(task) === "后台任务";
                  const t = isAsync ? ("task" as const) : undefined;
                  return (
                    <>
                      {!isAsync && active && (
                        <Button id={task.id} action="pause" label="暂停" />
                      )}
                      {!isAsync && task.status === "paused" && (
                        <Button id={task.id} action="resume" label="恢复" />
                      )}
                      {task.status !== "cancelled" && (
                        <Button id={task.id} action="cancel" label="取消" danger target={t} />
                      )}
                      {(task.status === "failed" || task.status === "cancelled") && (
                        <Button id={task.id} action="retry" label="重试" target={t} />
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
