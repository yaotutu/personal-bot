import { z } from "zod";
import { endpoints } from "./contracts/endpoints.js";

/**
 * OpenAPI 3.1 文档生成器：从端点注册表 + zod v4 schema 自动生成，
 * 禁止手写 OpenAPI 文件。schema 的 describe() 直接成为文档描述；
 * 请求体用 io=input、响应用 io=output 转换 JSON Schema（2020-12）。
 * z.toJSONSchema 可能把重复子 schema 提升为 $defs/$ref——OpenAPI 3.1 的
 * schema 对象允许内嵌 $defs，无需展开。
 */
const toSchema = (schema: z.ZodType, io: "input" | "output") =>
  z.toJSONSchema(schema, { io }) as Record<string, unknown>;

const pathParams = (path: string) => {
  const names = [...path.matchAll(/:([a-zA-Z]+)/g)].map((m) => m[1]!);
  return names.map((name) => ({
    name,
    in: "path" as const,
    required: true,
    schema: { type: "string" as const },
  }));
};

const queryParams = (query: z.ZodType) => {
  const json = toSchema(query, "input");
  return Object.entries((json.properties as Record<string, never>) ?? {}).map(([name, def]) => ({
    name,
    in: "query" as const,
    required: ((json.required as string[]) ?? []).includes(name),
    schema: def,
  }));
};

export const buildOpenApiDocument = () => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of endpoints) {
    const openapiPath = endpoint.path.replace(/:([a-zA-Z]+)/g, "{$1}");
    const operation: Record<string, unknown> = {
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
        // SSE 端点同样可能返回鉴权/参数错误（握手阶段）；只补通用错误形状，不引入业务细节。
        "4xx": {
          description: "客户端错误（401 未鉴权、400 参数非法、404 资源不存在）",
          content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } }, required: ["error"] } } },
        },
      };
    } else {
      operation.responses = {
        200: {
          description: "成功",
          content: { "application/json": { schema: toSchema(endpoint.response, "output") } },
        },
        // 通用错误形状：401 未登录/过期，400 请求非法，404 目标不存在，409 状态冲突。
        "4xx": {
          description: "客户端错误（401/400/404/409，见各端点描述）",
          content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } }, required: ["error"] } } },
        },
      };
    }
    paths[openapiPath] = { ...(paths[openapiPath] ?? {}), [endpoint.method]: operation };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "pi-muse API",
      version: "1.0.0",
      description:
        "基于 pi 内核的单用户个人助手服务端。鉴权：POST /api/session 换取 token，" +
        "之后所有 /api/* 请求带 Authorization: Bearer <token>（health/session/docs 除外）。" +
        "会话（threadId）相互隔离；聊天走 AG-UI SSE；写文件类操作经人工审批。" +
        "本文档由 src/http/contracts/ 的 zod schema 自动生成，修改接口请改 schema 而非此文件。",
    },
    servers: [{ url: "/" }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    paths,
  };
};
