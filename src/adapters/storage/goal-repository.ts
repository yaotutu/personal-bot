import { readFile } from "node:fs/promises";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import type { Goal, GoalRepository } from "../../features/goals/types.js";
import { readGoalsDocument, InvalidDocumentError } from "./document-schemas.js";
import { writeJsonDocument } from "./json-document.js";

const readGoals = async (file: string): Promise<Goal[]> => {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new InvalidDocumentError("goals");
  }
  return readGoalsDocument(value);
};

export const createGoalRepository = (file: string): GoalRepository => {
  const serialized = createSerializedWriter();
  return {
    read: () => readGoals(file),
    update: <T>(
      change: (goals: Goal[]) => { goals?: Goal[]; result: T },
    ): Promise<T> =>
      serialized(async () => {
        const goals = await readGoals(file);
        const changed = change(goals);
        if (changed.goals !== undefined) await writeJsonDocument(file, changed.goals);
        return changed.result;
      }),
  };
};
