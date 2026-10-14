import { readFile } from "node:fs/promises";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import type { TaskRepository } from "../../features/tasks/types.js";
import type { Task } from "../../features/tasks/types.js";
import { readTasksDocument, InvalidDocumentError } from "./document-schemas.js";
import { writeJsonDocument } from "./json-document.js";

/** 与 jobs 相同的读取语义：裸数组、损坏抛错、不静默清空。 */
const readTasks = async (file: string): Promise<Task[]> => {
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
    throw new InvalidDocumentError("tasks");
  }
  return readTasksDocument(value);
};

export const createTaskRepository = (file: string): TaskRepository => {
  const serialized = createSerializedWriter();
  return {
    read: () => readTasks(file),
    update: <T>(
      change: (tasks: Task[]) => { tasks?: Task[]; result: T },
    ): Promise<T> =>
      serialized(async () => {
        const tasks = await readTasks(file);
        const changed = change(tasks);
        if (changed.tasks !== undefined) await writeJsonDocument(file, changed.tasks);
        return changed.result;
      }),
  };
};
