import { createJsonArrayRepository } from "./json-repository.js";
import { readTasksDocument } from "./document-schemas.js";
import type { Task } from "../../features/tasks/types.js";
import type { TaskRepository } from "../../features/tasks/types.js";

/** 各域薄封装：类型对齐 + 文档校验注入；读写语义统一在 json-repository。 */
export const createTaskRepository = (file: string): TaskRepository =>
  createJsonArrayRepository<Task>(file, "tasks", readTasksDocument) as TaskRepository;
