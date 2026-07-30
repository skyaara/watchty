import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resetWatchtyData } from "./helpers";
import { runCli } from "./run-cli";

const HOMES_ROOT = join(import.meta.dir, ".tmp-homes");

/**
 * install-hooks / doctor normally use ~/.cursor. Tests set WATCHTY_CURSOR_DIR
 * under a disposable temp tree (os.homedir() is process-cached; creating a
 * literal ".cursor" dir is also blocked in some sandboxes).
 */
describe("install-hooks and doctor (temp HOME)", () => {
  let dataRoot: string;
  let home: string;
  let cursorDir: string;

  beforeEach(() => {
    resetWatchtyData();
    dataRoot = process.env.WATCHTY_ROOT!;
    mkdirSync(HOMES_ROOT, { recursive: true });
    home = mkdtempSync(join(HOMES_ROOT, "h-"));
    cursorDir = join(home, "cursor-config");
  });

  afterEach(() => {
    resetWatchtyData();
    rmSync(home, { recursive: true, force: true });
  });

  const env = () => ({
    WATCHTY_ROOT: dataRoot,
    HOME: home,
    WATCHTY_CURSOR_DIR: cursorDir,
  });

  test("install-hooks writes hooks.json under temp HOME", async () => {
    const { code, stdout, stderr } = await runCli(["install-hooks"], {
      env: env(),
    });
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("Wrote");

    const hooksPath = join(cursorDir, "hooks.json");
    expect(existsSync(hooksPath)).toBe(true);
    const raw = readFileSync(hooksPath, "utf8");
    expect(raw).toContain("watchty");
    expect(raw).toContain("sessionStart");
    expect(raw).toContain("preToolUse");
    expect(raw).toContain("\"matcher\": \"Shell\"");
    expect(raw).not.toContain("beforeShellExecution");
    expect(raw).toContain("postToolUseFailure");

    // install-hooks also installs shell tab-completion into WATCHTY_ROOT
    const shell = (process.env.SHELL ?? "").includes("bash") ? "bash" : "zsh";
    const completionFile =
      shell === "bash"
        ? join(dataRoot, "completions", "watchty.bash")
        : join(dataRoot, "completions", "_watchty");
    const rcFile = join(home, shell === "bash" ? ".bashrc" : ".zshrc");
    expect(existsSync(completionFile)).toBe(true);
    expect(existsSync(rcFile)).toBe(true);
    expect(readFileSync(rcFile, "utf8")).toContain("watchty completion");
    expect(stdout).toContain("completions");
  });

  test("install-hooks merges into existing non-watchty hooks", async () => {
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, "hooks.json"),
      JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [{ command: "echo other" }],
            stop: [{ command: "lint-staged" }],
          },
        },
        null,
        2,
      ) + "\n",
    );

    const { code, stdout } = await runCli(["install-hooks"], { env: env() });
    expect(code).toBe(0);
    expect(stdout).toContain("Merged");

    const hooks = JSON.parse(readFileSync(join(cursorDir, "hooks.json"), "utf8"));
    const sessionStart = hooks.hooks.sessionStart as { command: string }[];
    expect(sessionStart.some((e) => e.command.includes("echo other"))).toBe(
      true,
    );
    expect(sessionStart.some((e) => e.command.includes("watchty"))).toBe(true);
    expect(hooks.hooks.stop).toEqual([{ command: "lint-staged" }]);
  });

  test("reinstall preserves non-watchty hooks when watchty is already present", async () => {
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, "hooks.json"),
      JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [
              { command: "echo custom-start" },
              { command: "watchty hook" },
            ],
            stop: [{ command: "lint-staged" }],
          },
        },
        null,
        2,
      ) + "\n",
    );

    const { code } = await runCli(["install-hooks"], { env: env() });
    expect(code).toBe(0);

    const hooks = JSON.parse(readFileSync(join(cursorDir, "hooks.json"), "utf8"));
    const sessionStart = hooks.hooks.sessionStart as { command: string }[];
    expect(sessionStart.some((e) => e.command.includes("echo custom-start"))).toBe(
      true,
    );
    expect(sessionStart.some((e) => e.command.includes("watchty"))).toBe(true);
    expect(hooks.hooks.stop).toEqual([{ command: "lint-staged" }]);
  });

  test("install-hooks errors on invalid JSON without overwriting", async () => {
    mkdirSync(cursorDir, { recursive: true });
    const hooksPath = join(cursorDir, "hooks.json");
    writeFileSync(hooksPath, "{not-json");

    const { code, stderr } = await runCli(["install-hooks"], {
      env: env(),
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("not valid JSON");
    expect(readFileSync(hooksPath, "utf8")).toBe("{not-json");
  });

  test("doctor reports hooks status for temp HOME", async () => {
    const missing = await runCli(["doctor"], { env: env() });
    expect(missing.stdout).toContain("[!!] hooks.json:");
    expect(missing.stdout).toContain("install-hooks");
    expect(missing.stdout).toContain("[ok] data dir:");
    expect(missing.stdout).toContain(dataRoot);
    expect(missing.stdout).toContain("[!!] shell completion:");
    expect(missing.stdout).toContain("completion install");

    const installed = await runCli(["install-hooks"], { env: env() });
    expect(installed.code).toBe(0);

    const wired = await runCli(["doctor"], { env: env() });
    expect(wired.stdout).toContain("[ok] hooks.json:");
    expect(wired.stdout).toContain("wired");
    expect(wired.stdout).toContain("[ok] shell completion:");
  });

  test("install-hooks --workspace writes project .cursor/hooks.json", async () => {
    // Sandboxes often block creating dirs named ".cursor"; use the fixture that
    // already has one.
    const project = join(import.meta.dir, "fixtures", "with-cursor");
    const hooksPath = join(project, ".cursor", "hooks.json");
    const original = readFileSync(hooksPath, "utf8");

    try {
      const { code, stdout, stderr } = await runCli(
        ["install-hooks", "--workspace"],
        { env: env(), cwd: project },
      );
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toContain("(workspace)");
      expect(stdout).toContain(hooksPath);

      const raw = readFileSync(hooksPath, "utf8");
      expect(raw).toContain("watchty");
      expect(raw).toContain("sessionStart");
      // Global dir should stay untouched.
      expect(existsSync(join(cursorDir, "hooks.json"))).toBe(false);
    } finally {
      writeFileSync(hooksPath, original, "utf8");
    }
  });

  test("install-hooks --global ignores hooksScope=workspace config", async () => {
    const set = await runCli(["config", "set", "hooksScope", "workspace"], {
      env: env(),
    });
    expect(set.code).toBe(0);

    const { code, stdout } = await runCli(["install-hooks", "--global"], {
      env: env(),
    });
    expect(code).toBe(0);
    expect(stdout).toContain("(global)");
    expect(existsSync(join(cursorDir, "hooks.json"))).toBe(true);
  });

  test("install-hooks rejects conflicting scope flags", async () => {
    const { code, stderr } = await runCli(
      ["install-hooks", "--global", "--workspace"],
      { env: env() },
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain("either --global or --workspace");
  });

  test("install-hooks --workspace errors outside a Cursor project", async () => {
    const outside = join(home, "nowhere");
    mkdirSync(outside, { recursive: true });

    const { code, stderr } = await runCli(["install-hooks", "--workspace"], {
      env: env(),
      cwd: outside,
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("Not inside a Cursor workspace");
  });
});
