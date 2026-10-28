import { Hono } from "hono";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
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
import { isSpaceId } from "../../features/conversation/space-id.js";
import { withPurpose } from "../../features/dream/purpose.js";
import {
  updateSkillsSchema,
  saveInstructionsSchema,
  updateSpaceDreamSchema,
  resolveDreamPendingSchema,
  resetSpaceSchema,
} from "../contracts/rest.js";
import { UnknownSkillError } from "../../features/skills/service.js";

/**
 * 空间管理路由：多空间列表、重置会话、生命周期（含级联删除）、技能覆盖、专属指令与 Dream 配置。
 */
export const createSpaceRoutes = (dependencies: HttpDependencies) => {
  const { conversationHub, layout, jobs, monitors, skills, dream, actions, messageFeedbackRepository } = dependencies;
  const app = new Hono();

  // GET /api/spaces - 列出所有空间（最近活跃倒序，永远包含 local-main）
  app.get("/", async (c) => {
    return c.json({ spaces: await conversationHub.spaces() });
  });

  // POST /api/spaces/:spaceId/reset - 重置空间当前会话（保留私有工作区文件与规则/技能/Dream配置）
  app.post("/:spaceId/reset", async (c) => {
    const spaceId = c.req.param("spaceId");
    if (!isSpaceId(spaceId)) {
      return c.json({ error: "Invalid spaceId", code: "INVALID_SPACE_ID" }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = resetSpaceSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", code: "INVALID_REQUEST" }, 400);
    }
    const clearSchedules = parsed.data.clearSchedules ?? false;

    return conversationHub.resetSpace(spaceId, async ({ closeCurrent, reopen }) => {
      // 1. 记录重置前归属于该空间的待审批项 ID，用于准确统计作废项
      const pendingBefore = (await actions.snapshotPending()).filter((a) => {
        const actionSpaceId = a.spaceId;
        const workspaceSpaceId = a.workspaceSpaceId;
        return actionSpaceId === spaceId || workspaceSpaceId === spaceId;
      });
      const pendingIdsBefore = new Set(pendingBefore.map((a) => a.id));

      // 2. 优先取消归属于该空间的待审批项（在 closeCurrent 之前执行，主动触发取消）
      const cancelledFirst = await actions.cancelBySpaceId(spaceId);

      // 3. 关闭当前活跃的协调器与模型运行
      await closeCurrent();

      // 4. 补查一次是否有运行关闭期间被撤销或残留的审批项
      const cancelledSecond = await actions.cancelBySpaceId(spaceId);
      const cancelledIds = new Set([...cancelledFirst, ...cancelledSecond]);
      for (const id of pendingIdsBefore) {
        const action = await actions.get(id);
        if (action?.status === "cancelled") {
          cancelledIds.add(id);
        }
      }

      // 5. 清理会话历史 JSONL 文件，保留 skills.json / INSTRUCTIONS.md / DREAM.md / dream.json
      const sessionsDir = threadSessionsDir(layout, spaceId);
      if (existsSync(sessionsDir)) {
        const entries = await readdir(sessionsDir);
        for (const file of entries) {
          if (file.endsWith(".jsonl")) {
            await rm(join(sessionsDir, file), { force: true });
          }
        }
      }

      // 6. 反馈与会话同生命周期；旧 sessionId 文件删除，不能迁移到 reset 后的新会话
      await messageFeedbackRepository.removeSpace(spaceId);

      // 7. 重置该空间的 Dream 整理游标与待决项
      await dream.resetSpace(spaceId);

      // 8. 若勾选清理调度，级联删除该空间下的定时任务与监控
      let removedJobs = 0;
      let removedMonitors = 0;
      if (clearSchedules) {
        removedJobs = await jobs.removeByOriginSpaceId(spaceId);
        removedMonitors = await monitors.removeByOriginSpaceId(spaceId);
      } else {
        await monitors.clearPendingByOriginSpaceId(spaceId);
      }

      // 9. 用全新的 sessionId 重新打开并初始化该空间
      const nextConversation = await reopen();

      return c.json({
        ok: true,
        spaceId,
        sessionId: nextConversation.sessionId(),
        cancelledApprovals: cancelledIds.size,
        removed: {
          jobs: removedJobs,
          monitors: removedMonitors,
        },
      });
    });
  });

  // GET /api/spaces/:spaceId/skills - 读取空间技能生效状态
  app.get("/:spaceId/skills", async (c) => {
    const spaceId = c.req.param("spaceId");
    if (!isSpaceId(spaceId)) {
      return c.json({ error: "Invalid spaceId", code: "INVALID_SPACE_ID" }, 400);
    }
    return c.json(await skills.describeSpace(spaceId));
  });

  // PUT /api/spaces/:spaceId/skills - 保存空间技能覆盖
  app.put("/:spaceId/skills", async (c) => {
    const spaceId = c.req.param("spaceId");
    if (!isSpaceId(spaceId)) {
      return c.json({ error: "Invalid spaceId", code: "INVALID_SPACE_ID" }, 400);
    }

    const body = await c.req.json().catch(() => undefined);
    const parsed = updateSkillsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", code: "INVALID_REQUEST" }, 400);
    }

    try {
      return await conversationHub.withSpace(spaceId, async () => {
        await skills.updateSpaceOverrides(spaceId, parsed.data.overrides);
        return c.json(await skills.describeSpace(spaceId));
      });
    } catch (error) {
      if (error instanceof UnknownSkillError) return c.json({ error: error.message, code: "UNKNOWN_SKILL" }, 400);
      throw error;
    }
  });

  // GET /api/spaces/:spaceId/instructions - 读取空间专属规则
  app.get("/:spaceId/instructions", async (c) => {
    const spaceId = c.req.param("spaceId");
    if (!isSpaceId(spaceId)) {
      return c.json({ error: "Invalid spaceId", code: "INVALID_SPACE_ID" }, 400);
    }
    const file = threadInstructionsFile(layout, spaceId);
    const instructions = await readThreadInstructions(file);
    return c.json({ instructions });
  });

  // PUT /api/spaces/:spaceId/instructions - 保存空间专属规则（可选附带空间用途）
  app.put("/:spaceId/instructions", async (c) => {
    const spaceId = c.req.param("spaceId");
    if (!isSpaceId(spaceId)) {
      return c.json({ error: "Invalid spaceId", code: "INVALID_SPACE_ID" }, 400);
    }

    const body = await c.req.json().catch(() => undefined);
    const parsed = saveInstructionsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid instructions request", code: "INVALID_REQUEST" }, 400);
    }

    return conversationHub.withSpace(spaceId, async () => {
      const file = threadInstructionsFile(layout, spaceId);
      const text =
        parsed.data.purpose !== undefined
          ? withPurpose(parsed.data.instructions, parsed.data.purpose)
          : parsed.data.instructions;
      await writeThreadInstructions(file, text);
      const instructions = await readThreadInstructions(file);
      return c.json({ instructions });
    });
  });

  // GET /api/spaces/:spaceId/dream - 读取空间 Dream 状态与配置
  app.get("/:spaceId/dream", async (c) => {
    const spaceId = c.req.param("spaceId");
    if (!isSpaceId(spaceId)) {
      return c.json({ error: "Invalid spaceId", code: "INVALID_SPACE_ID" }, 400);
    }
    return c.json(await dream.describeSpace(spaceId));
  });

  // PUT /api/spaces/:spaceId/dream - 保存空间 Dream 开关与补充提示词
  app.put("/:spaceId/dream", async (c) => {
    const spaceId = c.req.param("spaceId");
    if (!isSpaceId(spaceId)) {
      return c.json({ error: "Invalid spaceId", code: "INVALID_SPACE_ID" }, 400);
    }
    const parsed = updateSpaceDreamSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid dream request", code: "INVALID_REQUEST" }, 400);
    }
    return conversationHub.withSpace(spaceId, async () => {
      return c.json(await dream.updateSpaceSettings(spaceId, parsed.data));
    });
  });

  // POST /api/spaces/:spaceId/dream/run - 立即运行当前空间的 Dream 整理
  app.post("/:spaceId/dream/run", async (c) => {
    const spaceId = c.req.param("spaceId");
    if (!isSpaceId(spaceId)) {
      return c.json({ error: "Invalid spaceId", code: "INVALID_SPACE_ID" }, 400);
    }
    const result = await dream.runNow(spaceId);
    if (!result.ok) {
      return c.json({ error: result.message }, result.code === "not_found" ? 404 : 409);
    }
    return c.json(result.state);
  });

  // POST /api/spaces/:spaceId/dream/pending/:pendingId - 处理待决建议
  app.post("/:spaceId/dream/pending/:pendingId", async (c) => {
    const spaceId = c.req.param("spaceId");
    if (!isSpaceId(spaceId)) {
      return c.json({ error: "Invalid spaceId", code: "INVALID_SPACE_ID" }, 400);
    }
    const parsed = resolveDreamPendingSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid dream pending decision", code: "INVALID_REQUEST" }, 400);
    }
    const result = await dream.resolvePending(
      spaceId,
      c.req.param("pendingId"),
      parsed.data,
    );
    if (!result.ok) {
      return c.json({ error: result.message }, result.code === "not_found" ? 404 : 409);
    }
    return c.json(result.state);
  });

  // DELETE /api/spaces/:spaceId - 删除空间（级联清理）
  app.delete("/:spaceId", async (c) => {
    const spaceId = c.req.param("spaceId");

    // 1. 主空间保护
    if (spaceId === "local-main") {
      return c.json({ error: "Cannot delete the main space", code: "CANNOT_DELETE_MAIN_SPACE" }, 409);
    }
    if (!isSpaceId(spaceId)) {
      return c.json({ error: "Invalid spaceId", code: "INVALID_SPACE_ID" }, 400);
    }

    return conversationHub.deleteSpace(spaceId, async () => {
      const spaceDir = threadSessionsDir(layout, spaceId);
      const dirExists = existsSync(spaceDir);
      const hasJobs = (await jobs.list()).some((j) => j.originSpaceId === spaceId);
      const hasMonitors = (await monitors.list()).some((m) => m.originSpaceId === spaceId);
      if (!dirExists && !hasJobs && !hasMonitors)
        return c.json({ error: "Space not found", code: "SPACE_NOT_FOUND" }, 404);

      // 生命周期锁已关闭旧协调器；等待所有来源绑定提交后再级联清理。
      const removedJobs = await jobs.removeByOriginSpaceId(spaceId);
      const removedMonitors = await monitors.removeByOriginSpaceId(spaceId);
      await actions.cancelBySpaceId(spaceId);
      await messageFeedbackRepository.removeSpace(spaceId);
      await rm(spaceDir, { recursive: true, force: true });
      await rm(threadWorkspaceDir(layout, spaceId), { recursive: true, force: true });
      return c.json({ ok: true, removed: { jobs: removedJobs, monitors: removedMonitors } });
    });
  });

  return app;
};
