import { createJsonArrayRepository } from "./json-repository.js";
import { readActionsDocument } from "./document-schemas.js";
import type { PendingAction } from "../../features/actions/types.js";
import type { ActionRepository } from "../../features/actions/types.js";

/** 各域薄封装：类型对齐 + 文档校验注入；读写语义统一在 json-repository。 */
export const createActionRepository = (file: string, onCommitted?: () => void): ActionRepository =>
  createJsonArrayRepository<PendingAction>(file, "actions", readActionsDocument, onCommitted) as ActionRepository;
