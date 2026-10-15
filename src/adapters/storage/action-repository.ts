import { readFile } from "node:fs/promises";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import type { ActionRepository, PendingAction } from "../../features/actions/types.js";
import { readActionsDocument, InvalidDocumentError } from "./document-schemas.js";
import { writeJsonDocument } from "./json-document.js";

const readActions = async (file: string): Promise<PendingAction[]> => {
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
    throw new InvalidDocumentError("actions");
  }
  return readActionsDocument(value);
};

export const createActionRepository = (file: string): ActionRepository => {
  const serialized = createSerializedWriter();
  return {
    read: () => readActions(file),
    update: <T>(
      change: (actions: PendingAction[]) => { actions?: PendingAction[]; result: T },
    ): Promise<T> =>
      serialized(async () => {
        const actions = await readActions(file);
        const changed = change(actions);
        if (changed.actions !== undefined) await writeJsonDocument(file, changed.actions);
        return changed.result;
      }),
  };
};
