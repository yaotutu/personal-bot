import { useEffect, useState } from "react";
import {
  createGoal,
  listGoals,
  removeGoal,
  setGoalStatus,
  toggleGoalMilestone,
  type GoalView,
} from "../lib/api";

const statusBadge: Record<GoalView["status"], { text: string; className: string }> = {
  active: { text: "进行中", className: "bg-blue-50 text-blue-700" },
  paused: { text: "已暂停", className: "bg-stone-100 text-stone-600" },
  completed: { text: "已完成", className: "bg-green-50 text-green-700" },
  archived: { text: "已归档", className: "bg-stone-100 text-stone-400" },
};

/** 目标页：长期目标 + 里程碑进度；改动下一轮对话注入生效。 */
export const GoalsView = () => {
  const [goals, setGoals] = useState<GoalView[]>([]);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [milestones, setMilestones] = useState("");

  const reload = () => {
    void listGoals()
      .then(setGoals)
      .catch((e: Error) => setError(e.message));
  };
  useEffect(reload, []);

  const submit = async () => {
    const list = milestones
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    try {
      await createGoal({
        title: title.trim(),
        category: category.trim() || undefined,
        milestones: list,
      });
      setTitle("");
      setCategory("");
      setMilestones("");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    }
    reload();
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    }
    reload();
  };

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="rounded-2xl border border-stone-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-stone-700">新目标</h2>
          <div className="mt-3 flex gap-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="目标，如：年底前完成半程马拉松"
              className="flex-1 rounded-lg border border-stone-300 px-3 py-1.5 text-sm outline-none focus:border-stone-500"
            />
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="分类（可选）"
              className="w-28 rounded-lg border border-stone-300 px-3 py-1.5 text-sm outline-none focus:border-stone-500"
            />
          </div>
          <textarea
            value={milestones}
            onChange={(e) => setMilestones(e.target.value)}
            placeholder={"里程碑（每行一个，可选）：\n跑量到 30km/周\n完成一次 15km 长距离"}
            rows={3}
            className="mt-2 w-full resize-y rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
          />
          <button
            onClick={() => title.trim() && void submit()}
            disabled={!title.trim()}
            className="mt-2 rounded-lg bg-stone-800 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            创建目标
          </button>
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>
        )}

        {goals.length === 0 && !error && (
          <div className="rounded-2xl border border-dashed border-stone-300 py-12 text-center text-sm text-stone-400">
            还没有目标；也可以直接对助手说"帮我建个目标…"
          </div>
        )}

        {goals.map((goal) => {
          const badge = statusBadge[goal.status];
          const done = goal.milestones.filter((m) => m.done).length;
          const total = goal.milestones.length;
          const pct = total ? Math.round((done / total) * 100) : null;
          return (
            <div key={goal.id} className="rounded-2xl border border-stone-200 bg-white p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-stone-800">{goal.title}</p>
                  <p className="mt-0.5 text-xs text-stone-400">
                    {goal.category} · 更新{" "}
                    {new Date(goal.updatedAt).toLocaleString("zh-CN", { hour12: false })}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}
                >
                  {badge.text}
                </span>
              </div>
              {goal.description && (
                <p className="mt-2 whitespace-pre-wrap text-sm text-stone-600">
                  {goal.description}
                </p>
              )}
              {total > 0 && (
                <>
                  <div className="mt-3 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-stone-100">
                      <div
                        className="h-full rounded-full bg-stone-700"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-stone-400">
                      {done}/{total}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {goal.milestones.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => void act(() => toggleGoalMilestone(goal.id, m.id))}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm hover:bg-stone-50"
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                            m.done
                              ? "border-stone-700 bg-stone-700 text-white"
                              : "border-stone-300"
                          }`}
                        >
                          {m.done ? "✓" : ""}
                        </span>
                        <span
                          className={m.done ? "text-stone-400 line-through" : "text-stone-700"}
                        >
                          {m.title}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              <div className="mt-3 flex gap-2">
                {goal.status === "active" && (
                  <button
                    onClick={() => void act(() => setGoalStatus(goal.id, "paused"))}
                    className="rounded-lg border border-stone-300 px-2.5 py-1 text-xs text-stone-600 hover:bg-stone-50"
                  >
                    暂停
                  </button>
                )}
                {goal.status === "paused" && (
                  <button
                    onClick={() => void act(() => setGoalStatus(goal.id, "active"))}
                    className="rounded-lg border border-stone-300 px-2.5 py-1 text-xs text-stone-600 hover:bg-stone-50"
                  >
                    激活
                  </button>
                )}
                {goal.status !== "completed" && goal.status !== "archived" && (
                  <>
                    <button
                      onClick={() => void act(() => setGoalStatus(goal.id, "completed"))}
                      className="rounded-lg border border-green-200 px-2.5 py-1 text-xs text-green-700 hover:bg-green-50"
                    >
                      完成
                    </button>
                    <button
                      onClick={() => void act(() => setGoalStatus(goal.id, "archived"))}
                      className="rounded-lg border border-stone-300 px-2.5 py-1 text-xs text-stone-500 hover:bg-stone-50"
                    >
                      归档
                    </button>
                  </>
                )}
                <button
                  onClick={() => void act(() => removeGoal(goal.id))}
                  className="rounded-lg border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
                >
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
