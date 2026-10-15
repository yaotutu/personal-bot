import { createJsonArrayRepository } from "./json-repository.js";
import { readGoalsDocument } from "./document-schemas.js";
import type { Goal } from "../../features/goals/types.js";
import type { GoalRepository } from "../../features/goals/types.js";

/** 各域薄封装：类型对齐 + 文档校验注入；读写语义统一在 json-repository。 */
export const createGoalRepository = (file: string): GoalRepository =>
  createJsonArrayRepository<Goal>(file, "goals", readGoalsDocument) as GoalRepository;
