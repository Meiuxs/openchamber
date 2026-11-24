import { describe, expect, test } from "bun:test";
import type { Message, Part } from "@/lib/opencode/model";
import { areEquivalent, areMessagesEquivalent, arePartsEquivalent } from "./event-equivalence";

const assistant = (overrides: Partial<Extract<Message, { role: "assistant" }>> = {}): Message => ({
  id: "msg_a",
  sessionID: "ses_1",
  role: "assistant",
  time: { created: 10 },
  agent: "build",
  providerID: "p",
  modelID: "m",
  ...overrides,
});

const textPart = (overrides: Partial<Extract<Part, { type: "text" }>> = {}): Part => ({
  id: "part_1",
  messageID: "msg_a",
  sessionID: "ses_1",
  type: "text",
  text: "hello",
  ...overrides,
});

const jsonEquivalent = (left: unknown, right: unknown): boolean => {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

describe("areEquivalent", () => {
  test("treats identical references as equal", () => {
    const value = { a: 1 };
    expect(areEquivalent(value, value)).toBe(true);
  });

  test("treats a missing side as different", () => {
    expect(areEquivalent(undefined, { a: 1 })).toBe(false);
    expect(areEquivalent({ a: 1 }, undefined)).toBe(false);
  });

  test("compares nested values structurally", () => {
    expect(areEquivalent({ a: { b: 2 } }, { a: { b: 2 } })).toBe(true);
    expect(areEquivalent({ a: { b: 2 } }, { a: { b: 3 } })).toBe(false);
  });

  test("does not ignore array order or extra keys", () => {
    expect(areEquivalent([1, 2], [2, 1])).toBe(false);
    expect(areEquivalent({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  test("agrees with JSON.stringify on representative values", () => {
    const pairs: Array<[unknown, unknown]> = [
      [{ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }],
      [{ a: 1 }, { a: 2 }],
      [null, null],
      [null, { a: 1 }],
      ["x", "x"],
      ["x", "y"],
      [[{ a: 1 }], [{ a: 1 }]],
    ];
    for (const [left, right] of pairs) {
      expect(areEquivalent(left, right)).toBe(jsonEquivalent(left, right));
    }
  });
});

describe("areMessagesEquivalent", () => {
  test("matches JSON equivalence for identical and changed messages", () => {
    const a = assistant();
    const b = assistant({ time: { created: 10 } });
    const c = assistant({ time: { created: 11 } });
    expect(areMessagesEquivalent(a, b)).toBe(true);
    expect(areMessagesEquivalent(a, c)).toBe(false);
  });
});

describe("arePartsEquivalent", () => {
  test("matches JSON equivalence for parts arrays", () => {
    const left = [textPart()];
    const same = [textPart()];
    const changed = [textPart({ text: "bye" })];
    expect(arePartsEquivalent(left, same)).toBe(true);
    expect(arePartsEquivalent(left, changed)).toBe(false);
    expect(arePartsEquivalent(left, [textPart(), textPart({ id: "part_2" })])).toBe(false);
  });
});
