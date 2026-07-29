import { describe, expect, test } from "bun:test";
import { cleanCommand } from "../src/command-display";

/**
 * The sidebar should show what the agent actually ran, not Cursor's
 * multi-line shell wrapper (export PATH, cd, set -e, etc.).
 */
describe("command sidebar labels", () => {
  test("shows a simple command as-is", () => {
    const out = cleanCommand("git status");
    expect(out.label).toBe("git status");
    expect(out.display).toBe("git status");
    expect(out.raw).toBe("git status");
  });

  test("surfaces the real command after agent boilerplate lines", () => {
    const wrapped = [
      "export PATH=/usr/bin:$PATH",
      "export BUN_INSTALL=$HOME/.bun",
      "cd '/Users/dev/my-app'",
      "set -euo pipefail",
      "bun test",
    ].join("\n");

    const out = cleanCommand(wrapped);
    expect(out.label).toContain("bun test");
    expect(out.display).not.toContain("export PATH");
    expect(out.display).not.toContain("cd '/Users/dev/my-app'");
    expect(out.raw).toBe(wrapped);
  });

  test("never loses the original transcript", () => {
    const raw = "export FOO=1\necho hello";
    expect(cleanCommand(raw).raw).toBe(raw);
  });

  test("uses a placeholder when nothing meaningful remains", () => {
    const out = cleanCommand("export PATH=/x\nset -e");
    expect(out.label.length).toBeGreaterThan(0);
    expect(out.raw).toBe("export PATH=/x\nset -e");
  });

  test("keeps long commands readable with a bounded label", () => {
    const long = "echo " + "x".repeat(200);
    expect(cleanCommand(long).label.length).toBeLessThanOrEqual(56);
  });

  test("shortens bun -e / eval bodies in the sidebar label", () => {
    const body = "console.log(" + "x".repeat(80) + ")";
    const out = cleanCommand(`bun -e '${body}'`);
    expect(out.label.startsWith("bun -e '")).toBe(true);
    expect(out.label.length).toBeLessThanOrEqual(56);
    expect(out.label).toContain("…");
  });

  test("strips inline export/cd boilerplate on a single line", () => {
    const out = cleanCommand("export FOO=1; cd /tmp; echo hi");
    expect(out.display).toBe("echo hi");
    expect(out.label).toContain("echo hi");
  });
});
