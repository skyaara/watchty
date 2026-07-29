import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeWatchtyHooks } from "../src/hooks";

const FIXTURE = join(import.meta.dir, "fixtures", "hooks-merge.json");

describe("hooks.json merge", () => {
  test("preserves unrelated hooks when adding watchty", () => {
    const { existing, ours, expected } = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const merged = mergeWatchtyHooks(existing, ours);
    expect(merged.hooks).toEqual(expected.hooks);
  });

  test("replaces prior watchty entries for the same event", () => {
    const merged = mergeWatchtyHooks(
      {
        version: 1,
        hooks: {
          sessionStart: [
            { command: "bun /old/watchty hook" },
            { command: "echo keep-me" },
          ],
        },
      },
      {
        version: 1,
        hooks: {
          sessionStart: [{ command: "watchty hook" }],
        },
      },
    );
    const entries = merged.hooks?.sessionStart as { command: string }[];
    expect(entries.map((e) => e.command)).toEqual([
      "echo keep-me",
      "watchty hook",
    ]);
  });
});
