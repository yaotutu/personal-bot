import { createJsonArrayRepository } from "./json-repository.js";
import { readJobsDocument } from "./document-schemas.js";
import type { Job } from "../../features/jobs/types.js";
import type { JobRepository } from "../../features/jobs/ports.js";

/** 定时任务 repository；读写语义统一在 json-repository，校验用 jobs 文档规则。 */
export const createJobRepository = (file: string, onCommitted?: () => void): JobRepository =>
  createJsonArrayRepository<Job>(file, "jobs", readJobsDocument, onCommitted) as JobRepository;
