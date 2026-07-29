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
  });

  test("install-hooks --force merges into existing non-watchty hooks", async () => {
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, "hooks.json"),
      JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [{ command: "echo other" }],
          },
        },
        null,
        2,
      ) + "\n",
    );

    const refused = await runCli(["install-hooks"], { env: env() });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("--force");

    const forced = await runCli(["install-hooks", "--force"], { env: env() });
    expect(forced.code).toBe(0);

    const hooks = JSON.parse(readFileSync(join(cursorDir, "hooks.json"), "utf8"));
    const sessionStart = hooks.hooks.sessionStart as { command: string }[];
    expect(sessionStart.some((e) => e.command.includes("echo other"))).toBe(
      true,
    );
    expect(sessionStart.some((e) => e.command.includes("watchty"))).toBe(true);
  });

  test("install-hooks --force replaces invalid JSON", async () => {
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, "hooks.json"), "{not-json");

    const { code, stdout } = await runCli(["install-hooks", "--force"], {
      env: env(),
    });
    expect(code).toBe(0);
    expect(stdout).toContain("--force");
    expect(
      JSON.parse(readFileSync(join(cursorDir, "hooks.json"), "utf8")).hooks,
    ).toBeDefined();
  });

  test("doctor reports hooks status for temp HOME", async () => {
    const missing = await runCli(["doctor"], { env: env() });
    expect(missing.stdout).toContain("[!!] hooks.json:");
    expect(missing.stdout).toContain("install-hooks");
    expect(missing.stdout).toContain("[ok] data dir:");
    expect(missing.stdout).toContain(dataRoot);

    const installed = await runCli(["install-hooks"], { env: env() });
    expect(installed.code).toBe(0);

    const wired = await runCli(["doctor"], { env: env() });
    expect(wired.stdout).toContain("[ok] hooks.json:");
    expect(wired.stdout).toContain("wired");
  });
});
