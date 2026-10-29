import { z } from "zod";
import { endpoints } from "./contracts/endpoints.js";
import { browserWebSocketContract } from "./contracts/browser.js";
import { serviceVersion, type ServiceVersion } from "../bootstrap/service-version.js";

const defaultVersion = await serviceVersion;

/**
 * OpenAPI 3.1 文档生成器：从端点注册表 + zod v4 schema 自动生成，
 * 禁止手写 OpenAPI 文件。schema 的 describe() 直接成为文档描述；
 * 请求体用 io=input、响应用 io=output 转换 JSON Schema（2020-12）。
 * z.toJSONSchema 可能把重复子 schema 提升为 $defs/$ref——OpenAPI 3.1 的
 * schema 对象允许内嵌 $defs，无需展开。
 */
const toSchema = (schema: z.ZodType, io: "input" | "output") =>
  z.toJSONSchema(schema, { io }) as Record<string, unknown>;

const describePathParam = (path: string, name: string): string => {
  if (name === "spaceId") {
    return "空间唯一标识；主空间固定为 local-main，其他空间由英文字母、数字、短横线与下划线组成";
  }
  if (name === "messageId" && path.includes("/messages/")) {
    return "可反馈的用户/助手消息稳定 ID；来自权威历史，不是工具结果或乐观流式消息";
  }
  if (name === "commentId") {
    return "服务端生成的消息评论 UUID";
  }
  if (name === "pendingId") {
    if (path.includes("/dream/")) {
      return "Dream 待决建议唯一标识（如 pd_...）";
    }
    return "待处理审批项唯一标识（如 apv_...）";
  }
  if (name === "mid") {
    if (path.includes("/milestones/")) {
      return "目标里程碑唯一标识（如 ms_1）";
    }
    return "记忆条目唯一标识（如 m_001）";
  }
  if (name === "id") {
    if (path.includes("/activities/")) return "执行活动唯一标识（如 act_...）";
    if (path.includes("/jobs/")) return "定时任务唯一标识（如 job_...）";
    if (path.includes("/monitors/")) return "网页监控唯一标识（如 mon_...）";
    if (path.includes("/memories/")) return "记忆条目唯一标识（如 m_...）";
    if (path.includes("/goals/")) return "长期目标唯一标识（如 goal_...）";
    if (path.includes("/approvals/")) return "审批项唯一标识（如 apv_...）";
    if (path.includes("/information/items/")) return "信息原始条目唯一标识（info_...）";
    if (path.includes("/information/runs/")) return "信息处理 run 唯一标识（inforun_...）";
    return "目标资源唯一标识";
  }
  if (name === "itemId" && path.includes("/information/items/")) {
    return "信息原始条目唯一标识（info_...）";
  }
  if (name === "runId" && path.includes("/information/runs/")) {
    return "信息处理 run 唯一标识（inforun_...）";
  }
  return `${name} 路径参数`;
};

const pathParams = (path: string) => {
  const names = [...path.matchAll(/:([a-zA-Z]+)/g)].map((m) => m[1]!);
  return names.map((name) => {
    const description = describePathParam(path, name);
    const schema =
      name === "spaceId"
        ? { type: "string" as const, minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$", description }
        : path.includes("/information/items/") && name === "itemId"
          ? { type: "string" as const, minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$", description }
          : path.includes("/information/runs/") && name === "runId"
            ? { type: "string" as const, minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$", description }
            : { type: "string" as const, description };
    return {
      name,
      in: "path" as const,
      description,
      required: true,
      schema,
    };
  });
};

const queryParams = (query: z.ZodType) => {
  const json = toSchema(query, "input");
  return Object.entries((json.properties as Record<string, Record<string, unknown>>) ?? {}).map(([name, def]) => {
    const description = typeof def?.description === "string" ? def.description : undefined;
    return {
      name,
      in: "query" as const,
      ...(description ? { description } : {}),
      required: ((json.required as string[]) ?? []).includes(name),
      schema: def,
    };
  });
};

/**
 * 通用错误形状：鉴权、参数与业务冲突共用 {error}。具体业务状态码（如 409 携带
 * 当前审批视图）由端点声明的 errorResponses 覆盖；这里只补未声明的兜底。
 */
const genericErrorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    code: { type: "string" },
  },
  required: ["error"],
};

const errorResponses = (
  endpoint: (typeof endpoints)[number],
): Record<string, unknown> => {
  const responses: Record<string, unknown> = {};
  if (endpoint.auth) {
    responses["401"] = {
      description: "未鉴权或 token 失效；先 POST /api/session 重新登录",
      content: { "application/json": { schema: genericErrorSchema } },
    };
  }
  for (const [code, spec] of Object.entries(endpoint.errorResponses ?? {})) {
    responses[code] = {
      description: spec.description,
      content: { "application/json": { schema: toSchema(spec.schema, "output") } },
    };
  }
  // 端点未声明任何业务错误时保留 4xx 兜底；已声明的具体状态码不再被范围覆盖，
  // 避免文档里同一错误出现两套互不一致的 schema。
  if (!endpoint.errorResponses) {
    responses["4xx"] = {
      description: "客户端错误（401/400/404/409，见各端点描述）",
      content: { "application/json": { schema: genericErrorSchema } },
    };
  }
  return responses;
};

const websocketContracts = {
  browser: {
    ...browserWebSocketContract,
    serverMessages: Object.fromEntries(
      Object.entries(browserWebSocketContract.serverMessages).map(([name, schema]) => [
        name,
        { description: schema.description ?? "", schema: toSchema(schema, "output") },
      ]),
    ),
    clientMessages: Object.fromEntries(
      Object.entries(browserWebSocketContract.clientMessages).map(([name, schema]) => [
        name,
        { description: schema.description ?? "", schema: toSchema(schema, "input") },
      ]),
    ),
  },
};

export const buildOpenApiDocument = (version: ServiceVersion = defaultVersion) => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of endpoints) {
    const openapiPath = endpoint.path.replace(/:([a-zA-Z]+)/g, "{$1}");
    const operation: Record<string, unknown> = {
      ...(endpoint.operationId ? { operationId: endpoint.operationId } : {}),
      summary: endpoint.summary,
      tags: [endpoint.tag],
      ...(endpoint.auth ? { security: [{ bearerAuth: [] }] } : {}),
    };
    if (endpoint.hint) {
      operation.description = endpoint.hint;
      operation["x-agent-hint"] = endpoint.hint;
    }
    const parameters = [...pathParams(endpoint.path), ...(endpoint.query ? queryParams(endpoint.query) : [])];
    if (parameters.length) operation.parameters = parameters;
    if (endpoint.request)
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: toSchema(endpoint.request, "input") } },
      };
    if (endpoint.sse) {
      operation.responses = {
        200: {
          description: endpoint.sse.description,
          content: {
            "text/event-stream": { schema: { type: "object" } },
          },
          // 各端点自带 events map：聊天 SSE 用 sseEvents，工作区通知流用 workspaceEvents；
          // 事件契约按各自命名空间渲染，互不混入。
          "x-sse-events": Object.fromEntries(
            Object.entries(endpoint.sse.events).map(([name, schema]) => [
              name,
              { description: schema.description ?? "", schema: toSchema(schema, "output") },
            ]),
          ),
        },
        // SSE 端点同样可能返回鉴权/参数错误（握手阶段）；具体错误由注册表声明。
        ...errorResponses(endpoint),
      };
    } else {
      const contentType = endpoint.responseContentType ?? "application/json";
      operation.responses = {
        200: {
          description: "成功",
          content: { [contentType]: { schema: toSchema(endpoint.response, "output") } },
        },
        ...errorResponses(endpoint),
      };
    }
    paths[openapiPath] = { ...(paths[openapiPath] ?? {}), [endpoint.method]: operation };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "pi-muse API",
      version: `${version.version}+${version.sourceHash.slice(0, 12)}`,
      description:
        `服务版本：${version.version}；运行模式：${version.mode}；commit：${version.commit ?? "unknown"}；` +
        `dirty：${version.dirty ?? "unknown"}；sourceHash（SHA-256）：${version.sourceHash}；构建时间：${version.builtAt ?? "源码模式，无构建时间"}。` +
        "这是启动/构建时固定的代码快照，与 GET /api/health.serviceVersion 及 x-service-version 一致。" +
        "dirty=true 时 commit 不代表完整代码，应比较 sourceHash；Git 信息不可用时明确为 null。" +
        "\n\n基于 pi 内核的单用户个人助手服务端。鉴权：POST /api/session 换取 token，" +
        "之后所有 /api/* 请求带 `Authorization: Bearer <token>`（health/session/docs 除外）。" +
        "空间（spaceId）相互隔离；聊天走 AG-UI SSE；写文件类操作经人工审批。" +
        "本文档由 src/http/contracts/ 的 zod schema 自动生成，修改接口请改 schema 而非此文件。",
    },
    "x-service-version": version,
    servers: [{ url: "/" }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    paths,
    "x-websocket-contracts": websocketContracts,
  };
};
