import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const defaultPath = fileURLToPath(
  new URL("../../config/prototype-calendar.local.json", import.meta.url),
);

export interface PrototypeCalendarConfig {
  enabled: true;
  sourceUrl: string;
}

export async function loadPrototypeCalendarConfig(
  path = defaultPath,
): Promise<PrototypeCalendarConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("PROTOTYPE_CALENDAR_CONFIG_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("PROTOTYPE_CALENDAR_CONFIG_INVALID");
  const record = value as Record<string, unknown>;
  if (record.enabled === false) return undefined;
  if (record.enabled !== true || typeof record.source_url !== "string")
    throw new Error("PROTOTYPE_CALENDAR_CONFIG_INVALID");
  return { enabled: true, sourceUrl: record.source_url };
}
