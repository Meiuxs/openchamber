import type { Message, Part } from "@/lib/opencode/model";

const jsonFallback = (left: unknown, right: unknown): boolean => {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const MAX_DEPTH = 64;

/**
 * Structural equality with JSON semantics, short-circuiting on reference
 * equality so a repeated update carrying the same long text string costs a
 * pointer compare instead of two full serializations.
 */
const compare = (left: unknown, right: unknown, depth: number): boolean => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left === null || right === null) return false;
  if (depth > MAX_DEPTH) return jsonFallback(left, right);
  if (typeof left !== "object" || typeof right !== "object") return false;

  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    const a = left as unknown[];
    const b = right as unknown[];
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      const leftItem = a[index] === undefined ? null : a[index];
      const rightItem = b[index] === undefined ? null : b[index];
      if (!compare(leftItem, rightItem, depth + 1)) return false;
    }
    return true;
  }

  if (!isPlainObject(left) || !isPlainObject(right)) return jsonFallback(left, right);

  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || right[key] === undefined) return false;
    if (!compare(left[key], right[key], depth + 1)) return false;
  }
  return true;
};

export const areEquivalent = (left: unknown, right: unknown): boolean => compare(left, right, 0);

export const areMessagesEquivalent = (left: Message | undefined, right: Message | undefined): boolean => (
  areEquivalent(left, right)
);

export const arePartsEquivalent = (left: readonly Part[] | undefined, right: readonly Part[] | undefined): boolean => (
  areEquivalent(left, right)
);
