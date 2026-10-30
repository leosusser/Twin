export type ProviderObject = Record<string, unknown>;

export function isProviderObject(value: unknown): value is ProviderObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asProviderObject(value: unknown): ProviderObject {
  return isProviderObject(value) ? value : {};
}

export function asProviderObjects(value: unknown): ProviderObject[] {
  return Array.isArray(value) ? value.filter(isProviderObject) : [];
}

export function asProviderString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNonEmptyProviderString(value: unknown): string | undefined {
  const text = asProviderString(value);
  return text?.trim() ? text : undefined;
}
