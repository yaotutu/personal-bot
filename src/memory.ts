import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// P3 长期记忆与身份设置：单文件 JSON 存储，条目式 CRUD。
// 权威来源只有这一个文件；注入层每轮重读，修改下一轮即生效。
// 不做自动提取（只显式写入），不存敏感凭证。
export type MemoryItem = {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};
export type Identity = {
  name: string;
  tone: string;
  avatar: string;
  showChatUpdates: boolean;
};
type MemoryState = {
  memories: MemoryItem[];
  identity: Identity;
};
const defaultIdentity: Identity = {
  name: "Personal Bot",
  tone: "warm",
  avatar: "sky",
  showChatUpdates: true,
};

async function load(dataDir: string): Promise<MemoryState> {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, "memory.json"), "utf8"));
    return {
      memories: Array.isArray(parsed.memories)
        ? parsed.memories.filter(
            (x: unknown): x is MemoryItem =>
              x !== null &&
              typeof x === "object" &&
              typeof (x as MemoryItem).id === "string" &&
              typeof (x as MemoryItem).text === "string",
          )
        : [],
      identity: { ...defaultIdentity, ...(parsed.identity ?? {}) },
    };
  } catch {
    return { memories: [], identity: { ...defaultIdentity } };
  }
}
async function save(dataDir: string, state: MemoryState) {
  await writeFile(join(dataDir, "memory.json"), JSON.stringify(state, null, 2) + "\n", {
    mode: 0o600,
  });
}

export async function createMemoryStore(dataDir: string) {
  // 串行化写操作：同一进程内的并发 CRUD 不产生交错写。
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
  };
  const now = () => new Date().toISOString();
  return {
    list: async (): Promise<MemoryItem[]> => (await load(dataDir)).memories,
    identity: async (): Promise<Identity> => (await load(dataDir)).identity,
    add: (text: string, source: string): Promise<MemoryItem> =>
      serialized(async () => {
        const state = await load(dataDir);
        const item: MemoryItem = {
          id: randomUUID(),
          text: text.trim(),
          source,
          createdAt: now(),
          updatedAt: now(),
        };
        // 上限 500 条：新条目挤掉最旧的，防止无界增长。
        state.memories.push(item);
        state.memories = state.memories.slice(-500);
        await save(dataDir, state);
        return item;
      }),
    edit: async (id: string, text: string): Promise<MemoryItem | undefined> =>
      serialized(async () => {
        const state = await load(dataDir);
        const item = state.memories.find((x) => x.id === id);
        if (!item) return undefined;
        item.text = text.trim();
        item.updatedAt = now();
        await save(dataDir, state);
        return item;
      }),
    forget: (id: string): Promise<boolean> =>
      serialized(async () => {
        const state = await load(dataDir);
        const before = state.memories.length;
        state.memories = state.memories.filter((x) => x.id !== id);
        await save(dataDir, state);
        return state.memories.length < before;
      }),
    saveIdentity: async (patch: Partial<Identity>): Promise<Identity> =>
      serialized(async () => {
        const state = await load(dataDir);
        state.identity = { ...state.identity, ...patch };
        await save(dataDir, state);
        return state.identity;
      }),
    // 注入层渲染：记忆列表 + 身份要点，拼进 system prompt。
    renderForPrompt: async (): Promise<string> => {
      const state = await load(dataDir);
      let out = "";
      if (state.memories.length) {
        out += "\n\n## Long-term memory (explicit, user-curated)\n";
        for (const item of state.memories)
          out += `- ${item.text.replace(/\s+/g, " ").trim()}\n`;
      }
      const { name, tone } = state.identity;
      if (name !== defaultIdentity.name || tone !== defaultIdentity.tone)
        out += `\n## Identity settings\n- Assistant name: ${name}\n- Tone: ${tone}\n`;
      return out;
    },
  };
}
export type MemoryStore = Awaited<ReturnType<typeof createMemoryStore>>;
