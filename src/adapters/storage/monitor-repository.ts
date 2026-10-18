import { createJsonArrayRepository } from "./json-repository.js";
import { readMonitorsDocument } from "./document-schemas.js";
import type { Monitor } from "../../features/monitors/types.js";
import type { MonitorRepository } from "../../features/monitors/types.js";

/** 各域薄封装：类型对齐 + 文档校验注入；读写语义统一在 json-repository。 */
export const createMonitorRepository = (file: string, onCommitted?: () => void): MonitorRepository =>
  createJsonArrayRepository<Monitor>(file, "monitors", readMonitorsDocument, onCommitted) as MonitorRepository;
