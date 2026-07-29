import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { printComplete } from "../src/completion";
import { mutateState, upsertSession } from "../src/store";
import { captureConsole, resetWatchtyData } from "./helpers";

describe("shell completion suggestions", () => {
  beforeEach(() => resetWatchtyData());
  afterEach(() => {
    resetWatchtyData();
    // Bun keeps a prior exitCode=1 if cleared with undefined; reset to 0.
    process.exitCode = 0;
  });

  test("lists unique short names and prefers recently updated sessions", () => {
    upsertSession("older-aaaaaaaa", {
      title: "my-app | Fix login",
      workspace: "/Users/dev/my-app",
    });
    upsertSession("newer-bbbbbbbb", {
      title: "my-app | Old work",
      workspace: "/Users/dev/my-app",
    });
    // upsertSession always stamps updatedAt=now; pin ages for sort order.
    mutateState((state) => {
      state.sessions["older-aaaaaaaa"]!.updatedAt = "2024-06-01T00:00:00.000Z";
      state.sessions["newer-bbbbbbbb"]!.updatedAt = "2024-06-02T00:00:00.000Z";
      state.sessions["newer-bbbbbbbb"]!.endedAt = "2024-06-02T00:00:00.000Z";
    });

    const { log } = captureConsole(() =>
      printComplete(["sessions", "--all"]),
    );
    expect(log[0]).toBe("Old work");
    expect(log).toContain("Fix login");
  });

  test("falls back to short id when short names and titles collide", () => {
    upsertSession("dup-aaaa1111", {
      title: "app | Same",
      workspace: "/Users/dev/a",
    });
    upsertSession("dup-bbbb2222", {
      title: "app | Same",
      workspace: "/Users/dev/b",
    });

    const { log } = captureConsole(() =>
      printComplete(["sessions", "--all"]),
    );
    expect(log.sort()).toEqual(["dup-aaaa", "dup-bbbb"].sort());
  });

  test("filters by workspace and prefix", () => {
    upsertSession("ws-1", {
      title: "alpha | Auth",
      workspace: "/Users/dev/alpha",
    });
    upsertSession("ws-2", {
      title: "beta | Auth",
      workspace: "/Users/dev/beta",
    });

    const { log } = captureConsole(() =>
      printComplete(["sessions", "--workspace", "alpha", "Au"]),
    );
    expect(log).toEqual(["Auth"]);
  });

  test("suggests workspaces, commands, and config keys", () => {
    upsertSession("w1", {
      title: "t",
      workspace: "/Users/dev/my-app",
    });

    const workspaces = captureConsole(() =>
      printComplete(["workspaces", "my"]),
    ).log;
    expect(workspaces).toContain("my-app");

    const commands = captureConsole(() =>
      printComplete(["commands", "co"]),
    ).log;
    expect(commands).toContain("config");
    expect(commands).toContain("complete");

    const keys = captureConsole(() =>
      printComplete(["config-keys", "hook"]),
    ).log;
    expect(keys).toEqual(["hooksScope"]);
  });

  test("rejects unknown completion targets", () => {
    const { error } = captureConsole(() => printComplete(["nope"]));
    expect(error.join("\n")).toContain("usage:");
    expect(process.exitCode).toBe(1);
  });
});
