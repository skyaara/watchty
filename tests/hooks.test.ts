import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeWatchtyHooks, parseInstallHooksArgs } from "../src/hooks";

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

describe("install-hooks flags", () => {
  test("parses --global / --workspace", () => {
    expect(parseInstallHooksArgs(["--global"]).scope).toBe("global");
    expect(parseInstallHooksArgs(["-w"]).scope).toBe("workspace");
    expect(parseInstallHooksArgs(["--local"]).scope).toBe("workspace");
    expect(parseInstallHooksArgs([]).scope).toBeUndefined();
  });

  test("rejects conflicting or unknown flags", () => {
    expect(parseInstallHooksArgs(["--global", "--workspace"]).error).toContain(
      "either",
    );
    expect(parseInstallHooksArgs(["--scope", "global"]).error).toContain(
      "unknown",
    );
    expect(parseInstallHooksArgs(["--force"]).error).toContain("unknown");
  });
});
