import { useEffect, useState } from "react";
import {
  addMemory,
  editMemory,
  forgetMemory,
  getAgentSnapshot,
  getProfile,
  saveIdentity,
  saveProfile,
  type IdentityDto,
  type MemoryDto,
} from "../lib/api";

const TONES: { value: string; label: string }[] = [
  { value: "warm", label: "温和" },
  { value: "concise", label: "简洁" },
  { value: "thoughtful", label: "细致" },
];

/** 设置页：身份（名字/语气）、记忆 CRUD、SOUL/USER 自由文本；改动下一轮对话生效。 */
export const SettingsView = () => {
  const [identity, setIdentity] = useState<IdentityDto | null>(null);
  const [memories, setMemories] = useState<MemoryDto[]>([]);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [profile, setProfile] = useState<{ soul: string; user: string } | null>(null);
  const [notice, setNotice] = useState("");

  const flash = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(""), 2500);
  };

  const reload = () => {
    void getAgentSnapshot().then((data) => {
      setIdentity(data.identity);
      setMemories(data.memories);
    });
    void getProfile().then(setProfile);
  };

  useEffect(reload, []);

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

        <section className="rounded-2xl border border-stone-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-stone-700">长期记忆</h2>
          <p className="mt-1 text-xs text-stone-400">
            每轮对话自动注入；也可以直接对助手说“记住/忘掉 …”。
          </p>
          <div className="mt-3 space-y-2">
            {memories.length === 0 && (
              <p className="py-2 text-center text-sm text-stone-400">还没有记忆</p>
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
                              reload();
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
                              reload();
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
                      reload();
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
                    reload();
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
