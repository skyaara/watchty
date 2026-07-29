import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resetWatchtyData } from "./helpers";
import { runCli } from "./run-cli";
import { upsertSession } from "../src/store";

describe("watchty CLI (subprocess)", () => {
  let dataRoot: string;

  beforeEach(() => {
    resetWatchtyData();
    dataRoot = process.env.WATCHTY_ROOT!;
  });

  afterEach(() => {
    resetWatchtyData();
  });

  test("help prints usage", async () => {
    const { code, stdout } = await runCli(["help"], { env: { WATCHTY_ROOT: dataRoot } });
    expect(code).toBe(0);
    expect(stdout).toContain("watchty hook");
    expect(stdout).toContain("watchty view");
  });

  test("list reports empty state", async () => {
    const { code, stdout } = await runCli(["list"], { env: { WATCHTY_ROOT: dataRoot } });
    expect(code).toBe(0);
    expect(stdout).toContain("No sessions yet");
  });

  test("list shows planted sessions", async () => {
    upsertSession("cli-s1", {
      title: "my-app | Fix login",
      workspace: "/Users/dev/my-app",
    });

    const { code, stdout } = await runCli(["list", "--all"], {
      env: { WATCHTY_ROOT: dataRoot },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Fix login");
    expect(stdout).toContain("live");
  });

  test("config set persists values", async () => {
    const set = await runCli(["config", "set", "autoOpen", "false"], {
      env: { WATCHTY_ROOT: dataRoot },
    });
    expect(set.code).toBe(0);

    const show = await runCli(["config"], { env: { WATCHTY_ROOT: dataRoot } });
    expect(show.stdout).toContain('"autoOpen": false');
  });

  test("cleanup dry-run does not delete sessions", async () => {
    upsertSession("old-one", {
      title: "stale",
      endedAt: "2020-01-01T00:00:00.000Z",
    });

    const { code, stdout } = await runCli(["cleanup", "--ttl", "1h", "--dry-run"], {
      env: { WATCHTY_ROOT: dataRoot },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("would remove");
    expect(existsSync(join(dataRoot, "state.json"))).toBe(true);
  });

  test("hook reads JSON from stdin and writes transcript", async () => {
    const payload = JSON.stringify({
      hook_event_name: "sessionStart",
      conversation_id: "cli-hook-1",
      workspace_roots: ["/tmp/project"],
      title: "CLI hook test",
    });

    const { code } = await runCli(["hook"], {
      env: { WATCHTY_ROOT: dataRoot, WATCHTY_AUTO_OPEN: "false" },
      stdin: payload + "\n",
    });
    expect(code).toBe(0);

    const eventsPath = join(dataRoot, "sessions", "cli-hook-1.jsonl");
    expect(existsSync(eventsPath)).toBe(true);
    const line = readFileSync(eventsPath, "utf8").trim();
    expect(JSON.parse(line)).toMatchObject({ type: "session_start" });
  });

  test("complete sessions suggests planted session names", async () => {
    upsertSession("complete-1", {
      title: "my-app | Refactor auth",
      workspace: "/Users/dev/my-app",
    });

    const { code, stdout } = await runCli(
      ["complete", "sessions", "--all", "Ref"],
      { env: { WATCHTY_ROOT: dataRoot } },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Refactor auth");
  });
});
