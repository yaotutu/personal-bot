import { useEffect, useState } from "react";
import {
  addMemory,
  editMemory,
  forgetMemory,
  getAgentSnapshot,
  getDreamOverview,
  getProfile,
  getSpaceDream,
  getSpaceInstructions,
  listMemories,
  resolveSpaceDreamPending,
  runSpaceDream,
  saveGlobalDreamPrompt,
  saveIdentity,
  saveProfile,
  saveSpaceInstructions,
  updateSpaceDream,
  type DreamOverviewDto,
  type DreamSpaceDto,
  type IdentityDto,
  type MemoryDto,
} from "../lib/api";

const TONES: { value: string; label: string }[] = [
  { value: "warm", label: "温和" },
  { value: "concise", label: "简洁" },
  { value: "thoughtful", label: "细致" },
];

const TARGET_LABELS: Record<"user" | "soul" | "instructions" | "memory", string> = {
  user: "USER.md（用户画像）",
  soul: "SOUL.md（助手人设）",
  instructions: "本空间 INSTRUCTIONS.md",
  memory: "memory.json（长期记忆）",
};

/** 设置页：身份、按需检索记忆、SOUL/USER 人设、空间指令与 Dream 后台记忆整理。 */
export const SettingsView = ({ spaceId = "local-main" }: { spaceId?: string }) => {
  const currentSpaceId = spaceId;
  const [identity, setIdentity] = useState<IdentityDto | null>(null);
  const [memories, setMemories] = useState<MemoryDto[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [profile, setProfile] = useState<{ soul: string; user: string } | null>(null);
  const [instructions, setInstructions] = useState("");
  const [purpose, setPurpose] = useState("");
  const [dreamOverview, setDreamOverview] = useState<DreamOverviewDto | null>(null);
  const [spaceDream, setSpaceDream] = useState<DreamSpaceDto | null>(null);
  const [pendingTargets, setPendingTargets] = useState<
    Record<string, "user" | "soul" | "instructions" | "memory">
  >({});
  const [runningDream, setRunningDream] = useState(false);
  const [notice, setNotice] = useState("");

  const flash = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(""), 2500);
  };

  const reloadMemories = (query = searchQuery) => {
    void listMemories(query).then(setMemories, (e: Error) => flash(e.message));
  };

  const reload = () => {
    void getAgentSnapshot().then((data) => {
      setIdentity(data.identity);
    });
    reloadMemories();
    void getProfile().then(setProfile);
    void getSpaceInstructions(currentSpaceId).then((data) => setInstructions(data.instructions));
    void getDreamOverview().then(setDreamOverview);
    void getSpaceDream(currentSpaceId).then((data) => {
      setSpaceDream(data);
      setPurpose(data.purpose);
    });
  };

  useEffect(reload, [currentSpaceId]);

  const allPending = (dreamOverview?.spaces ?? []).flatMap((item) =>
    item.pending.map((entry) => ({ ...entry, spaceId: item.spaceId })),
  );

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-2xl space-y-6">
        {notice && (
          <div className="rounded-lg bg-green-50 px-3 py-2 text-center text-sm text-green-700">
            {notice}
          </div>
        )}

        {identity && (
          <section className="rounded-2xl border border-stone-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-stone-700">身份</h2>
            <div className="mt-3 flex items-center gap-3">
              <label className="text-sm text-stone-600">名字</label>
              <input
                value={identity.name}
                onChange={(e) => setIdentity({ ...identity, name: e.target.value })}
                className="flex-1 rounded-lg border border-stone-300 px-3 py-1.5 text-sm outline-none focus:border-stone-500"
              />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <label className="text-sm text-stone-600">语气</label>
              {TONES.map((tone) => (
                <button
                  key={tone.value}
                  onClick={() => setIdentity({ ...identity, tone: tone.value })}
                  className={`rounded-lg px-3 py-1.5 text-sm ${
                    identity.tone === tone.value
                      ? "bg-stone-800 text-white"
                      : "border border-stone-300 text-stone-600 hover:bg-stone-50"
                  }`}
                >
                  {tone.label}
                </button>
              ))}
            </div>
            <button
              onClick={() =>
                void saveIdentity(identity).then(
                  () => flash("身份已保存，下一轮对话生效"),
                  (e: Error) => flash(e.message),
                )
              }
              className="mt-4 rounded-lg bg-stone-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-stone-700"
            >
              保存身份
            </button>
          </section>
        )}

        {dreamOverview && spaceDream && (
          <section className="rounded-2xl border border-stone-200 bg-white p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-stone-700">
                  Dream 后台记忆整理（每 {dreamOverview.intervalHours} 小时）
                </h2>
                <p className="mt-0.5 text-xs text-stone-400">
                  当前空间：{currentSpaceId}。SOUL/USER/空间指令每轮常驻；memory.json 作为沉淀库按需检索。
                </p>
              </div>
              <button
                disabled={runningDream}
                onClick={() => {
                  setRunningDream(true);
                  void runSpaceDream(currentSpaceId)
                    .then(
                      () => {
                        reload();
                        flash("整理已完成");
                      },
                      (e: Error) => flash(e.message),
                    )
                    .finally(() => setRunningDream(false));
                }}
                className="rounded-lg bg-stone-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50"
              >
                {runningDream ? "整理中…" : "立即整理此空间"}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-sm text-stone-700">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={spaceDream.enabled}
                  onChange={(e) =>
                    void updateSpaceDream(currentSpaceId, { enabled: e.target.checked }).then(
                      (next) => {
                        setSpaceDream(next);
                        flash(next.enabled ? "已开启自动整理" : "已关闭自动整理");
                      },
                      (err: Error) => flash(err.message),
                    )
                  }
                />
                <span>开启此空间自动整理</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={spaceDream.inheritGlobalPrompt}
                  onChange={(e) =>
                    void updateSpaceDream(currentSpaceId, {
                      inheritGlobalPrompt: e.target.checked,
                    }).then(
                      (next) => {
                        setSpaceDream(next);
                        flash("已更新继承设置");
                      },
                      (err: Error) => flash(err.message),
                    )
                  }
                />
                <span>继承全局 Dream 提示词</span>
              </label>
            </div>

            {spaceDream.lastRun && (
              <div className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">
                <div>
                  最近整理：{spaceDream.lastRun.at} · 状态：{spaceDream.lastRun.status} · 处理新消息：
                  {spaceDream.lastRun.processed} 条
                  {spaceDream.lastRun.changed.length > 0 &&
                    ` · 已更新：${spaceDream.lastRun.changed.join(", ")}`}
                </div>
                {spaceDream.lastRun.error && (
                  <div className="mt-1 text-red-600">错误：{spaceDream.lastRun.error}</div>
                )}
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-stone-500">
                空间指令（sessions/{currentSpaceId}/INSTRUCTIONS.md，每轮携带）
              </label>
              {!purpose && (
                <div className="mt-1 flex gap-2">
                  <input
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                    placeholder="可选：声明空间用途（生成 ## 空间用途 段落，供 Dream 归类本空间规则）"
                    className="flex-1 rounded-lg border border-stone-300 px-2.5 py-1 text-xs outline-none focus:border-stone-500"
                  />
                </div>
              )}
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={4}
                placeholder="例如：## 空间用途\n处理工作邮件草稿\n\n每封回信以 Best regards 结尾。"
                className="mt-1 w-full resize-y rounded-lg border border-stone-300 px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-stone-500"
              />
              <button
                onClick={() =>
                  void saveSpaceInstructions(
                    currentSpaceId,
                    instructions,
                    purpose && !instructions.includes("## 空间用途") ? purpose : undefined,
                  ).then(
                    (saved) => {
                      setInstructions(saved.instructions);
                      void getSpaceDream(currentSpaceId).then((next) => {
                        setSpaceDream(next);
                        setPurpose(next.purpose);
                      });
                      flash("空间指令已保存");
                    },
                    (e: Error) => flash(e.message),
                  )
                }
                className="mt-2 rounded-lg border border-stone-300 px-3 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
              >
                保存空间指令
              </button>
            </div>

            <div>
              <label className="text-xs font-medium text-stone-500">
                此空间 Dream 补充提示词（sessions/{currentSpaceId}/DREAM.md）
              </label>
              <textarea
                value={spaceDream.prompt}
                onChange={(e) => setSpaceDream({ ...spaceDream, prompt: e.target.value })}
                rows={3}
                placeholder="仅对当前空间生效的额外整理提示词…"
                className="mt-1 w-full resize-y rounded-lg border border-stone-300 px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-stone-500"
              />
              <button
                onClick={() =>
                  void updateSpaceDream(currentSpaceId, { prompt: spaceDream.prompt }).then(
                    (next) => {
                      setSpaceDream(next);
                      flash("空间 Dream 提示词已保存");
                    },
                    (e: Error) => flash(e.message),
                  )
                }
                className="mt-2 rounded-lg border border-stone-300 px-3 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
              >
                保存空间补充提示词
              </button>
            </div>

            <div>
              <label className="text-xs font-medium text-stone-500">
                全局 Dream 提示词（DREAM.md；留空使用内置默认提示词）
              </label>
              <textarea
                value={dreamOverview.globalPrompt}
                onChange={(e) =>
                  setDreamOverview({ ...dreamOverview, globalPrompt: e.target.value })
                }
                rows={4}
                placeholder={dreamOverview.defaultPrompt}
                className="mt-1 w-full resize-y rounded-lg border border-stone-300 px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-stone-500"
              />
              <button
                onClick={() =>
                  void saveGlobalDreamPrompt(dreamOverview.globalPrompt).then(
                    (next) => {
                      setDreamOverview(next);
                      flash("全局 Dream 提示词已保存");
                    },
                    (e: Error) => flash(e.message),
                  )
                }
                className="mt-2 rounded-lg border border-stone-300 px-3 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
              >
                保存全局提示词
              </button>
            </div>

            {allPending.length > 0 && (
              <div className="space-y-2 border-t border-stone-200 pt-3">
                <h3 className="text-xs font-semibold text-stone-700">
                  待确认归属的建议（{allPending.length}）
                </h3>
                {allPending.map((item) => {
                  const chosen = pendingTargets[item.id] ?? item.suggestedTarget;
                  return (
                    <div
                      key={item.id}
                      className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs space-y-2"
                    >
                      <div className="flex items-center justify-between text-stone-500">
                        <span>来源空间：{item.spaceId}</span>
                        <span>原因：{item.reason}</span>
                      </div>
                      <p className="whitespace-pre-wrap text-sm text-stone-800">{item.text}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={chosen}
                          onChange={(e) =>
                            setPendingTargets({
                              ...pendingTargets,
                              [item.id]: e.target.value as
                                | "user"
                                | "soul"
                                | "instructions"
                                | "memory",
                            })
                          }
                          className="rounded border border-stone-300 bg-white px-2 py-1 text-xs"
                        >
                          {(["user", "soul", "instructions", "memory"] as const).map((t) => (
                            <option key={t} value={t}>
                              {TARGET_LABELS[t]}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() =>
                            void resolveSpaceDreamPending(item.spaceId, item.id, {
                              action: "apply",
                              target: chosen,
                            }).then(
                              () => {
                                reload();
                                flash("已确认写入");
                              },
                              (e: Error) => flash(e.message),
                            )
                          }
                          className="rounded bg-stone-800 px-2.5 py-1 text-xs font-medium text-white"
                        >
                          确认写入
                        </button>
                        <button
                          onClick={() =>
                            void resolveSpaceDreamPending(item.spaceId, item.id, {
                              action: "dismiss",
                            }).then(
                              () => {
                                reload();
                                flash("已忽略");
                              },
                              (e: Error) => flash(e.message),
                            )
                          }
                          className="rounded border border-stone-300 bg-white px-2.5 py-1 text-xs text-stone-600"
                        >
                          忽略
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        <section className="rounded-2xl border border-stone-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-stone-700">长期记忆（沉淀库）</h2>
          <p className="mt-1 text-xs text-stone-400">
            按需通过 memory_search 检索，不再每轮全量携带；也可对助手说“记住/忘掉 …”。
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                reloadMemories(e.target.value);
              }}
              placeholder="按关键词检索记忆…"
              className="flex-1 rounded-lg border border-stone-300 px-3 py-1.5 text-sm outline-none focus:border-stone-500"
            />
          </div>
          <div className="mt-3 space-y-2">
            {memories.length === 0 && (
              <p className="py-2 text-center text-sm text-stone-400">还没有匹配的记忆</p>
            )}
            {memories.map((memory) => (
              <div
                key={memory.id}
                className="rounded-lg border border-stone-200 px-3 py-2 text-sm"
              >
                {editing?.id === memory.id ? (
                  <div className="space-y-2">
                    <textarea
                      value={editing.text}
                      onChange={(e) => setEditing({ id: memory.id, text: e.target.value })}
                      rows={2}
                      className="w-full resize-none rounded border border-stone-300 px-2 py-1 text-sm outline-none focus:border-stone-500"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() =>
                          void editMemory(memory.id, editing.text).then(
                            () => {
                              setEditing(null);
                              reloadMemories();
                              flash("已修改");
                            },
                            (e: Error) => flash(e.message),
                          )
                        }
                        className="rounded bg-stone-800 px-3 py-1 text-xs font-medium text-white"
                      >
                        保存
                      </button>
                      <button
                        onClick={() => setEditing(null)}
                        className="rounded border border-stone-300 px-3 py-1 text-xs text-stone-600"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <p className="whitespace-pre-wrap text-stone-700">{memory.text}</p>
                    <div className="flex shrink-0 gap-1">
                      <button
                        onClick={() => setEditing({ id: memory.id, text: memory.text })}
                        className="rounded border border-stone-300 px-2 py-0.5 text-xs text-stone-600 hover:bg-stone-50"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() =>
                          void forgetMemory(memory.id).then(
                            () => {
                              reloadMemories();
                              flash("已删除");
                            },
                            (e: Error) => flash(e.message),
                          )
                        }
                        className="rounded border border-red-200 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
                      >
                        忘记
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim())
                  void addMemory(draft.trim()).then(
                    () => {
                      setDraft("");
                      reloadMemories();
                      flash("已记住");
                    },
                    (err: Error) => flash(err.message),
                  );
              }}
              placeholder="记住一些关于我的事…"
              className="flex-1 rounded-lg border border-stone-300 px-3 py-1.5 text-sm outline-none focus:border-stone-500"
            />
            <button
              onClick={() =>
                draft.trim() &&
                void addMemory(draft.trim()).then(
                  () => {
                    setDraft("");
                    reloadMemories();
                    flash("已记住");
                  },
                  (err: Error) => flash(err.message),
                )
              }
              className="rounded-lg bg-stone-800 px-4 py-1.5 text-sm font-medium text-white"
            >
              记住
            </button>
          </div>
        </section>

        {profile && (
          <section className="rounded-2xl border border-stone-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-stone-700">人设文件（SOUL / USER）</h2>
            <p className="mt-1 text-xs text-stone-400">
              自由文本，每轮注入 system prompt；清空内容等于移除该段人设。
            </p>
            {(
              [
                { key: "soul", label: "SOUL.md（助手性格）" },
                { key: "user", label: "USER.md（用户画像）" },
              ] as const
            ).map(({ key, label }) => (
              <div key={key} className="mt-3">
                <label className="text-xs font-medium text-stone-500">{label}</label>
                <textarea
                  value={profile[key]}
                  onChange={(e) => setProfile({ ...profile, [key]: e.target.value })}
                  rows={6}
                  className="mt-1 w-full resize-y rounded-lg border border-stone-300 px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-stone-500"
                />
              </div>
            ))}
            <button
              onClick={() =>
                void saveProfile(profile).then(
                  () => flash("人设已保存，下一轮对话生效"),
                  (e: Error) => flash(e.message),
                )
              }
              className="mt-3 rounded-lg bg-stone-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-stone-700"
            >
              保存人设
            </button>
          </section>
        )}
      </div>
    </div>
  );
};
