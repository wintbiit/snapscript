export function isPlainObjectMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertPlainObjectMap(
  label: string,
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!isPlainObjectMap(value)) {
    throw new Error(`${label} must be an object (plain object map)`);
  }
}
