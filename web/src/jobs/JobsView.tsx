import { useEffect, useState } from "react";
import { controlTask, getAgentSnapshot, type TaskView } from "../lib/api";

const statusLabel: Record<string, { text: string; className: string }> = {
  scheduled: { text: "已排期", className: "bg-blue-50 text-blue-700" },
  running: { text: "执行中", className: "bg-amber-50 text-amber-700" },
  paused: { text: "已暂停", className: "bg-stone-100 text-stone-600" },
  succeeded: { text: "上次成功", className: "bg-green-50 text-green-700" },
  failed: { text: "上次失败", className: "bg-red-50 text-red-700" },
  cancelled: { text: "已取消", className: "bg-stone-100 text-stone-400" },
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

  const reload = () => {
    void getAgentSnapshot()
      .then((data) => setTasks(data.tasks))
      .catch((e: Error) => setError(e.message));
  };

  useEffect(reload, []);

  const act = async (id: string, action: "pause" | "resume" | "cancel" | "retry") => {
    setBusy(`${id}:${action}`);
    const result = await controlTask(id, action);
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
  }: {
    id: string;
    action: "pause" | "resume" | "cancel" | "retry";
    label: string;
    danger?: boolean;
  }) => (
    <button
      disabled={busy.length > 0}
      onClick={() => void act(id, action)}
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
        <p className="text-xs text-stone-400">
          新建任务：在聊天里说“明天 9 点提醒我 …”或“每天 8 点 …”。
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
                <span
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}
                >
                  {badge.text}
                </span>
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
                {active && <Button id={task.id} action="pause" label="暂停" />}
                {task.status === "paused" && <Button id={task.id} action="resume" label="恢复" />}
                {task.status !== "cancelled" && (
                  <Button id={task.id} action="cancel" label="取消" danger />
                )}
                {(task.status === "failed" || task.status === "cancelled") && (
                  <Button id={task.id} action="retry" label="重试" />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
