import { readFile } from "node:fs/promises";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import type { Monitor, MonitorRepository } from "../../features/monitors/types.js";
import { readMonitorsDocument, InvalidDocumentError } from "./document-schemas.js";
import { writeJsonDocument } from "./json-document.js";

const readMonitors = async (file: string): Promise<Monitor[]> => {
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
    throw new InvalidDocumentError("monitors");
  }
  return readMonitorsDocument(value);
};

export const createMonitorRepository = (file: string): MonitorRepository => {
  const serialized = createSerializedWriter();
  return {
    read: () => readMonitors(file),
    update: <T>(
      change: (monitors: Monitor[]) => { monitors?: Monitor[]; result: T },
    ): Promise<T> =>
      serialized(async () => {
        const monitors = await readMonitors(file);
        const changed = change(monitors);
        if (changed.monitors !== undefined) await writeJsonDocument(file, changed.monitors);
        return changed.result;
      }),
  };
};
