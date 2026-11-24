import { describe, expect, test } from "bun:test";
import { createMessageIndexHints } from "./message-index-hints";

const msg = (id: string) => ({ id });

describe("createMessageIndexHints", () => {
  test("finds a message and returns -1 when missing", () => {
    const hints = createMessageIndexHints();
    const messages = [msg("a"), msg("b"), msg("c")];
    expect(hints.find(messages, "b")).toBe(1);
    expect(hints.find(messages, "zzz")).toBe(-1);
  });

  test("hint stays correct when the array shifts", () => {
    const hints = createMessageIndexHints();
    const before = [msg("a"), msg("b"), msg("c")];
    expect(hints.find(before, "c")).toBe(2);
    const after = [msg("x"), msg("a"), msg("b"), msg("c")];
    expect(hints.find(after, "c")).toBe(3);
  });

  test("forget drops a stale hint but still finds by scan", () => {
    const hints = createMessageIndexHints();
    const messages = [msg("a"), msg("b")];
    expect(hints.find(messages, "b")).toBe(1);
    hints.forget("b");
    expect(hints.find(messages, "b")).toBe(1);
  });

  test("clear resets all hints", () => {
    const hints = createMessageIndexHints();
    const messages = [msg("a")];
    expect(hints.find(messages, "a")).toBe(0);
    hints.clear();
    expect(hints.find(messages, "a")).toBe(0);
  });
});
