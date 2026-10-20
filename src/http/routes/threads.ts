import { Hono } from "hono";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { HttpDependencies } from "../../bootstrap/types.js";
import {
  threadSessionsDir,
  threadWorkspaceDir,
  threadInstructionsFile,
} from "../../adapters/storage/data-layout.js";
import {
  readThreadInstructions,
  writeThreadInstructions,
} from "../../adapters/storage/thread-instructions.js";
import { isThreadId } from "../../features/conversation/validate-input.js";
import { withPurpose } from "../../features/dream/purpose.js";
import {
  updateSkillsSchema,
  saveInstructionsSchema,
  updateThreadDreamSchema,
  resolveDreamPendingSchema,
} from "../contracts/rest.js";
import { UnknownSkillError } from "../../features/skills/service.js";

/**
 * 会话管理路由：多会话列表、会话生命周期（含级联删除）、技能覆盖、专属指令与 Dream 配置。
 */
export const createThreadRoutes = (dependencies: HttpDependencies) => {
  const { conversationHub, layout, jobs, monitors, skills, dream } = dependencies;
  const app = new Hono();

  // GET /api/threads - 列出所有会话（最近活跃倒序，永远包含 local-main）
  app.get("/", async (c) => {
    return c.json({ threads: await conversationHub.threads() });
  });

  // GET /api/threads/:threadId/skills - 读取会话技能生效状态
  app.get("/:threadId/skills", async (c) => {
    const threadId = c.req.param("threadId");
    if (!isThreadId(threadId)) {
      return c.json({ error: "Invalid threadId" }, 400);
    }
    return c.json(await skills.describeThread(threadId));
  });

  // PUT /api/threads/:threadId/skills - 保存会话技能覆盖
  app.put("/:threadId/skills", async (c) => {
    const threadId = c.req.param("threadId");
    if (!isThreadId(threadId)) {
      return c.json({ error: "Invalid threadId" }, 400);
    }

    const body = await c.req.json().catch(() => undefined);
    const parsed = updateSkillsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    try {
      return await conversationHub.withThread(threadId, async () => {
        await skills.updateThreadOverrides(threadId, parsed.data.overrides);
        return c.json(await skills.describeThread(threadId));
      });
    } catch (error) {
      if (error instanceof UnknownSkillError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  // GET /api/threads/:threadId/instructions - 读取会话专属规则
  app.get("/:threadId/instructions", async (c) => {
    const threadId = c.req.param("threadId");
    if (!isThreadId(threadId)) {
      return c.json({ error: "Invalid threadId" }, 400);
    }
    const file = threadInstructionsFile(layout, threadId);
    const instructions = await readThreadInstructions(file);
    return c.json({ instructions });
  });

  // PUT /api/threads/:threadId/instructions - 保存会话专属规则（可选附带会话用途）
  app.put("/:threadId/instructions", async (c) => {
    const threadId = c.req.param("threadId");
    if (!isThreadId(threadId)) {
      return c.json({ error: "Invalid threadId" }, 400);
    }

    const body = await c.req.json().catch(() => undefined);
    const parsed = saveInstructionsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid instructions request" }, 400);
    }

    return conversationHub.withThread(threadId, async () => {
      const file = threadInstructionsFile(layout, threadId);
      const text =
        parsed.data.purpose !== undefined
          ? withPurpose(parsed.data.instructions, parsed.data.purpose)
          : parsed.data.instructions;
      await writeThreadInstructions(file, text);
      const instructions = await readThreadInstructions(file);
      return c.json({ instructions });
    });
  });

  // GET /api/threads/:threadId/dream - 读取会话 Dream 状态与配置
  app.get("/:threadId/dream", async (c) => {
    const threadId = c.req.param("threadId");
    if (!isThreadId(threadId)) {
      return c.json({ error: "Invalid threadId" }, 400);
    }
    return c.json(await dream.describeThread(threadId));
  });

  // PUT /api/threads/:threadId/dream - 保存会话 Dream 开关与补充提示词
  app.put("/:threadId/dream", async (c) => {
    const threadId = c.req.param("threadId");
    if (!isThreadId(threadId)) {
      return c.json({ error: "Invalid threadId" }, 400);
    }
    const parsed = updateThreadDreamSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid dream request" }, 400);
    }
    return conversationHub.withThread(threadId, async () => {
      return c.json(await dream.updateThreadSettings(threadId, parsed.data));
    });
  });

  // POST /api/threads/:threadId/dream/run - 立即运行当前会话的 Dream 整理
  app.post("/:threadId/dream/run", async (c) => {
    const threadId = c.req.param("threadId");
    if (!isThreadId(threadId)) {
      return c.json({ error: "Invalid threadId" }, 400);
    }
    const result = await dream.runNow(threadId);
    if (!result.ok) {
      return c.json({ error: result.message }, result.code === "not_found" ? 404 : 409);
    }
    return c.json(result.state);
  });

  // POST /api/threads/:threadId/dream/pending/:pendingId - 处理待决建议
  app.post("/:threadId/dream/pending/:pendingId", async (c) => {
    const threadId = c.req.param("threadId");
    if (!isThreadId(threadId)) {
      return c.json({ error: "Invalid threadId" }, 400);
    }
    const parsed = resolveDreamPendingSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid dream pending decision" }, 400);
    }
    const result = await dream.resolvePending(
      threadId,
      c.req.param("pendingId"),
      parsed.data,
    );
    if (!result.ok) {
      return c.json({ error: result.message }, result.code === "not_found" ? 404 : 409);
    }
    return c.json(result.state);
  });

  // DELETE /api/threads/:threadId - 删除会话（级联清理）
  app.delete("/:threadId", async (c) => {
    const threadId = c.req.param("threadId");

    // 1. 主会话保护
    if (threadId === "local-main") {
      return c.json({ error: "Cannot delete the main thread" }, 409);
    }
    if (!isThreadId(threadId)) {
      return c.json({ error: "Invalid threadId" }, 400);
    }

    return conversationHub.deleteThread(threadId, async () => {
      const threadDir = threadSessionsDir(layout, threadId);
      const dirExists = existsSync(threadDir);
      const hasJobs = (await jobs.list()).some((j) => j.originThreadId === threadId);
      const hasMonitors = (await monitors.list()).some((m) => m.originThreadId === threadId);
      if (!dirExists && !hasJobs && !hasMonitors)
        return c.json({ error: "Thread not found" }, 404);

      // 生命周期锁已关闭旧协调器；等待所有来源绑定提交后再级联清理。
      const removedJobs = await jobs.removeByOriginThreadId(threadId);
      const removedMonitors = await monitors.removeByOriginThreadId(threadId);
      await rm(threadDir, { recursive: true, force: true });
      await rm(threadWorkspaceDir(layout, threadId), { recursive: true, force: true });
      return c.json({ ok: true, removed: { jobs: removedJobs, monitors: removedMonitors } });
    });
  });

  return app;
};
