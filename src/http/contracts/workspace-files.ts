import { z } from "zod";

const spaceIdSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const scopeSchema = z.enum(["space", "shared"]).describe("文件根选择器：space=指定空间私有区；shared=全局共享区");
const readPathSchema = z.string().min(1).max(2048).describe(
  "相对所选根的路径。列表可传 `.` 表示根目录；读取现存文件时允许历史遗留的非 ASCII 名称，但拒绝绝对路径、反斜杠、空段、`.`/`..` 与 NUL。",
);
const writePathSchema = z.string().min(1).max(2048).regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/).describe(
  "新建/更新/删除的相对文件路径；每段只允许 ASCII 字母、数字、`.`、`-`、`_`，且拒绝 `.`、`..`、绝对路径、反斜杠与目录路径。",
);

const selectorRules = (
  value: { scope: "space" | "shared"; spaceId?: string },
  ctx: z.RefinementCtx,
) => {
    if (value.scope === "space" && !value.spaceId)
      ctx.addIssue({ code: "custom", path: ["spaceId"], message: "scope=space 时 spaceId 必填" });
    if (value.scope === "shared" && value.spaceId)
      ctx.addIssue({ code: "custom", path: ["spaceId"], message: "scope=shared 时必须省略 spaceId" });
};

const selectorCheck = <S extends z.ZodRawShape>(shape: S) =>
  z.strictObject(shape).superRefine((value, ctx) => {
    selectorRules(value as { scope: "space" | "shared"; spaceId?: string }, ctx);
  });

export const workspaceListQuerySchema = selectorCheck({
  scope: scopeSchema,
  spaceId: spaceIdSchema.optional().describe("空间 ID；仅 scope=space 时必填，且空间必须已存在"),
  path: readPathSchema.default(".").describe("要列出的目录路径；默认 `.` 表示所选根目录"),
});

export const workspaceContentQuerySchema = selectorCheck({
  scope: scopeSchema,
  spaceId: spaceIdSchema.optional().describe("空间 ID；仅 scope=space 时必填，且空间必须已存在"),
  path: readPathSchema.describe("要完整打开/下载的现存普通文件路径"),
});

export const workspaceDeleteQuerySchema = selectorCheck({
  scope: scopeSchema,
  spaceId: spaceIdSchema.optional().describe("空间 ID；仅 scope=space 时必填，且空间必须已存在"),
  path: writePathSchema.describe("要删除的普通文件路径；目录与符号链接拒绝"),
});

const writeRequestShape = {
  scope: scopeSchema,
  spaceId: spaceIdSchema.optional().describe("空间 ID；仅 scope=space 时必填，且空间必须已存在；GET 或写入都不会隐式创建空间"),
  path: writePathSchema,
  content: z.string().describe("完整 UTF-8 文本内容；最大 100000 字节，禁止 NUL，不用于任意二进制"),
  confirmed: z.literal(true).describe("客户端必须已向用户展示完整 before/after 并获得明确确认；false/省略返回 400"),
};

export const workspaceCreateTextSchema = selectorCheck(writeRequestShape).describe(
  "仅新建文本文件；目标已存在返回 409，不覆盖。",
);
export const workspaceUpdateTextSchema = selectorCheck(writeRequestShape).describe(
  "仅更新已存在文本文件；目标缺失返回 404，不截断旧文件，成功后返回实际写入内容。",
);

const selectorFields = {
  scope: scopeSchema,
  spaceId: z.string().nullable().describe("scope=space 时为空间 ID；scope=shared 时固定为 null"),
};

export const workspaceListEntry = z.object({
  name: z.string().describe("目录条目名称"),
  path: z.string().describe("相对所选根的条目路径"),
  kind: z.enum(["file", "directory"]).describe("条目类型；符号链接与其他特殊文件不返回"),
  size: z.number().int().nonnegative().describe("文件字节数；目录固定为 0"),
  updatedAt: z.string().describe("条目 mtime（ISO 8601）"),
});

export const workspaceListResponse = z.object({
  ...selectorFields,
  path: z.string().describe("本次列出的目录路径；根目录为 `.`"),
  entries: z.array(workspaceListEntry).describe("目录优先、名称升序；超过 1000 项返回 413，不截断"),
});

export const workspaceFileMetadata = z.object({
  name: z.string().describe("文件名"),
  path: z.string().describe("相对所选根的文件路径"),
  kind: z.enum(["text", "image", "binary"]).describe(
    "text=严格 UTF-8 且无 NUL；image=魔数确认的 PNG/JPEG/GIF/WebP；binary=其余普通文件",
  ),
  size: z.number().int().nonnegative().describe("文件字节数"),
  updatedAt: z.string().describe("文件 mtime（ISO 8601）"),
  mimeType: z.string().describe("服务端判定的 MIME 类型；SVG/HTML 也按文本返回，客户端不得执行"),
});

export const workspaceTextDetail = z.object({
  ...workspaceFileMetadata.shape,
  kind: z.literal("text"),
  content: z.string().describe("完整文本内容；服务端不按文件扩展名伪装二进制"),
});

export const workspaceBinaryDetail = z.object({
  ...workspaceFileMetadata.shape,
  kind: z.enum(["image", "binary"]),
  dataBase64: z.string().describe("完整文件内容的 Base64；最大下载 8388608 字节"),
});

export const workspaceContentResponse = z.object({
  ...selectorFields,
  ...workspaceFileMetadata.shape,
}).and(z.union([workspaceTextDetail, workspaceBinaryDetail]));

export const workspaceTextWriteResponse = z.object({
  ...selectorFields,
  ...workspaceTextDetail.shape,
});

export const workspaceDeleteResponse = z.object({
  ...selectorFields,
  path: z.string().describe("已删除的相对文件路径"),
  ok: z.literal(true),
});

export type WorkspaceListQueryDto = z.infer<typeof workspaceListQuerySchema>;
export type WorkspaceContentQueryDto = z.infer<typeof workspaceContentQuerySchema>;
export type WorkspaceDeleteQueryDto = z.infer<typeof workspaceDeleteQuerySchema>;
export type WorkspaceCreateTextDto = z.infer<typeof workspaceCreateTextSchema>;
export type WorkspaceUpdateTextDto = z.infer<typeof workspaceUpdateTextSchema>;
export type WorkspaceListResponseDto = z.infer<typeof workspaceListResponse>;
export type WorkspaceContentResponseDto = z.infer<typeof workspaceContentResponse>;
export type WorkspaceTextWriteResponseDto = z.infer<typeof workspaceTextWriteResponse>;
export type WorkspaceDeleteResponseDto = z.infer<typeof workspaceDeleteResponse>;
