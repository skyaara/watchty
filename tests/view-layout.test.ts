import { describe, expect, test } from "bun:test";
import {
  BOLD,
  DIM,
  GREEN,
  RED,
  RESET,
  buildPanelLines,
  buildPromptHeader,
  buildSidebarItems,
  clipVisible,
  expandTabs,
  homeify,
  isNewPrompt,
  sidebarLabelText,
  statusGlyph,
  stripAnsi,
  truncatePlain,
  truncateStyled,
  visibleLen,
} from "../src/view-layout";
import type { CommandRow } from "../src/store";

function cmd(partial: Partial<CommandRow> & Pick<CommandRow, "id" | "command">): CommandRow {
  return {
    startedAt: "2024-01-01T00:00:00.000Z",
    output: "",
    running: false,
    ...partial,
  };
}

describe("view layout helpers", () => {
  describe("isNewPrompt", () => {
    test("splits when generationId changes", () => {
      const a = cmd({ id: "1", command: "a", generationId: "g1" });
      const b = cmd({ id: "2", command: "b", generationId: "g2" });
      expect(isNewPrompt(a, b)).toBe(true);
      expect(isNewPrompt(a, cmd({ id: "3", command: "c", generationId: "g1" }))).toBe(
        false,
      );
    });

    test("splits legacy events on 90s idle gaps", () => {
      const a = cmd({
        id: "1",
        command: "a",
        startedAt: "2024-01-01T00:00:00.000Z",
      });
      const near = cmd({
        id: "2",
        command: "b",
        startedAt: "2024-01-01T00:01:00.000Z",
      });
      const far = cmd({
        id: "3",
        command: "c",
        startedAt: "2024-01-01T00:02:00.000Z",
      });
      expect(isNewPrompt(a, near)).toBe(false);
      expect(isNewPrompt(a, far)).toBe(true);
    });
  });

  describe("buildSidebarItems", () => {
    test("inserts prompt headers and rules between generations", () => {
      const cmds = [
        cmd({ id: "1", command: "bun test", generationId: "g1" }),
        cmd({ id: "2", command: "git status", generationId: "g1" }),
        cmd({ id: "3", command: "npm run build", generationId: "g2" }),
      ];
      const prompts = new Map([
        ["g1", { prompt: "run tests" }],
        ["g2", { prompt: "build it" }],
      ]);
      expect(buildSidebarItems(cmds, prompts)).toEqual([
        { kind: "prompt" },
        { kind: "cmd", index: 0 },
        { kind: "cmd", index: 1 },
        { kind: "rule" },
        { kind: "prompt" },
        { kind: "cmd", index: 2 },
      ]);
    });

    test("skips prompt rows when generation has no stored prompt text", () => {
      const cmds = [cmd({ id: "1", command: "ls", generationId: "g1" })];
      expect(buildSidebarItems(cmds, new Map())).toEqual([
        { kind: "cmd", index: 0 },
      ]);
    });
  });

  describe("statusGlyph", () => {
    test("shows success and failure marks", () => {
      expect(statusGlyph(cmd({ id: "1", command: "ok", exitCode: 0 }), false)).toBe(
        `${GREEN}•${RESET}`,
      );
      expect(statusGlyph(cmd({ id: "2", command: "no", exitCode: 1 }), false)).toBe(
        `${RED}!${RESET}`,
      );
    });

    test("omits RESET when selected so reverse video can wrap the row", () => {
      expect(statusGlyph(cmd({ id: "1", command: "ok", exitCode: 0 }), true)).toBe(
        `${GREEN}•`,
      );
    });
  });

  describe("text clipping", () => {
    test("truncatePlain clips with ellipsis", () => {
      expect(truncatePlain("hello", 10)).toBe("hello");
      expect(truncatePlain("hello world", 8)).toBe("hello...");
      expect(truncatePlain("abcd", 2)).toBe("..");
      expect(truncatePlain("x", 0)).toBe("");
    });

    test("stripAnsi and visibleLen ignore style codes", () => {
      const styled = `${BOLD}hi${RESET}`;
      expect(stripAnsi(styled)).toBe("hi");
      expect(visibleLen(styled)).toBe(2);
    });

    test("expandTabs aligns to tab stops", () => {
      expect(expandTabs("a\tb")).toBe("a       b");
    });

    test("clipVisible pads or truncates to exact width", () => {
      expect(clipVisible("hi", 4)).toBe("hi  ");
      expect(clipVisible(`${DIM}hello world${RESET}`, 8)).toBe("hello...");
    });

    test("truncateStyled keeps ANSI while clipping visible width", () => {
      const out = truncateStyled(`${GREEN}abcdefghij${RESET}`, 7);
      expect(visibleLen(out)).toBeLessThanOrEqual(7);
      expect(out).toContain("...");
      expect(out).toContain(GREEN);
    });
  });

  describe("homeify / sidebarLabelText / prompt header", () => {
    test("homeify rewrites HOME prefix to ~", () => {
      const home = process.env.HOME ?? "/Users/dev";
      expect(homeify(`${home}/proj`)).toBe("~/proj");
      expect(homeify("/other/path")).toBe("/other/path");
      expect(homeify(undefined)).toBe("");
    });

    test("sidebarLabelText prefers basename of path commands", () => {
      expect(sidebarLabelText("/usr/local/bin/git status")).toBe("git status");
      expect(sidebarLabelText("bun test")).toBe("bun test");
    });

    test("buildPromptHeader wraps and truncates to max rows", () => {
      const lines = buildPromptHeader("one two three four five six", 14, 2);
      expect(lines).toHaveLength(2);
      expect(stripAnsi(lines[0]!)).toMatch(/^› /);
      expect(stripAnsi(lines[1]!)).toMatch(/^  /);
    });

    test("buildPromptHeader returns empty for blank or narrow width", () => {
      expect(buildPromptHeader("  ", 40)).toEqual([]);
      expect(buildPromptHeader("hello", 4)).toEqual([]);
    });

    test("buildPromptHeader appends model name below the prompt", () => {
      const lines = buildPromptHeader("fix the bug", 40, 2, "claude-opus-4-6");
      expect(lines).toHaveLength(2);
      expect(stripAnsi(lines[0]!)).toBe("› fix the bug");
      expect(stripAnsi(lines[1]!)).toBe("claude-opus-4-6");
      expect(lines[1]!).toContain(DIM);
    });

    test("buildPromptHeader can show model alone", () => {
      const lines = buildPromptHeader(undefined, 40, 2, "grok");
      expect(lines).toHaveLength(1);
      expect(stripAnsi(lines[0]!)).toBe("grok");
    });
  });

  describe("buildPanelLines", () => {
    test("empty selection shows a hint", () => {
      const lines = buildPanelLines(undefined, 40);
      expect(stripAnsi(lines.join("\n"))).toContain("select a command");
    });

    test("shows exit status and hides PATH preamble", () => {
      const lines = buildPanelLines(
        cmd({
          id: "1",
          command: "export PATH=/x:$PATH\nbun test",
          cwd: "/tmp/app",
          exitCode: 0,
          durationMs: 42,
          output: "ok\n",
        }),
        60,
      );
      const plain = stripAnsi(lines.join("\n"));
      expect(plain).toContain("bun test");
      expect(plain).toContain("(env preamble hidden)");
      expect(plain).toContain("exit 0 · 42ms");
      expect(plain).toContain("ok");
    });

    test("failed commands surface exit code", () => {
      const lines = buildPanelLines(
        cmd({
          id: "1",
          command: "false",
          exitCode: 1,
          output: "",
        }),
        40,
      );
      expect(stripAnsi(lines.join("\n"))).toContain("exit 1");
    });

    test("running commands without output show a running banner", () => {
      const lines = buildPanelLines(
        cmd({
          id: "1",
          command: "sleep 1",
          running: true,
          output: "",
        }),
        40,
      );
      expect(stripAnsi(lines.join("\n"))).toContain("running");
    });
  });
});
