import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resetWatchtyData } from "./helpers";
import {
  appendEvent,
  claimViewer,
  eventsToCommands,
  eventsToPrompts,
  getSession,
  listSessions,
  loadEvents,
  releaseViewer,
  upsertSession,
} from "../src/store";

/**
 * Hooks append jsonl transcripts; list/view/focus read them back.
 */
describe("session store and transcripts", () => {
  beforeEach(() => resetWatchtyData());
  afterEach(() => resetWatchtyData());

  const sessionId = "conv-test-001";

  test("creates a session with an on-disk jsonl file", () => {
    upsertSession(sessionId, {
      title: "Fix login",
      workspace: "/tmp/proj",
    });

    const s = getSession(sessionId);
    expect(s?.title).toBe("Fix login");
    expect(s?.workspace).toBe("/tmp/proj");
    expect(existsSync(s!.eventsPath)).toBe(true);
  });

  test("appends one JSON event per line to the transcript", () => {
    appendEvent(sessionId, {
      type: "session_start",
      at: "2026-01-01T00:00:00.000Z",
      title: "Fix login",
    });

    const lines = readFileSync(getSession(sessionId)!.eventsPath, "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "session_start" });
  });

  test("lists sessions newest-first", () => {
    upsertSession("older", { title: "old" });
    Bun.sleepSync(5);
    upsertSession("newer", { title: "new" });

    const ids = listSessions().map((s) => s.id);
    expect(ids[0]).toBe("newer");
    expect(ids[1]).toBe("older");
  });

  test("filters sessions by workspace query", () => {
    upsertSession("a", { title: "A", workspace: "/Users/dev/alpha" });
    upsertSession("b", { title: "B", workspace: "/Users/dev/beta" });

    const alpha = listSessions({ workspace: "alpha" });
    expect(alpha.map((s) => s.id)).toEqual(["a"]);
  });

  test("reconstructs running and finished commands from events", () => {
    const events = [
      {
        type: "cmd_start" as const,
        id: "c1",
        at: "2026-01-01T00:00:01.000Z",
        command: "bun test",
        generationId: "g1",
      },
      {
        type: "cmd_end" as const,
        id: "c1",
        at: "2026-01-01T00:00:02.000Z",
        exitCode: 0,
        durationMs: 1000,
        output: "ok",
      },
      {
        type: "cmd_start" as const,
        id: "c2",
        at: "2026-01-01T00:00:03.000Z",
        command: "git status",
      },
    ];

    const rows = eventsToCommands(events);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      command: "bun test",
      running: false,
      exitCode: 0,
      output: "ok",
      generationId: "g1",
    });
    expect(rows[1]).toMatchObject({ command: "git status", running: true });
  });

  test("maps user prompts to agent generations", () => {
    const prompts = eventsToPrompts([
      {
        type: "prompt",
        at: "t1",
        generationId: "g1",
        prompt: "  run tests  ",
      },
      {
        type: "prompt",
        at: "t2",
        generationId: "g1",
        prompt: "run tests again",
      },
    ]);
    expect(prompts.get("g1")).toEqual({ prompt: "run tests again" });
  });

  test("maps model onto prompt generations when present", () => {
    const prompts = eventsToPrompts([
      {
        type: "prompt",
        at: "t1",
        generationId: "g1",
        prompt: "hello",
        model: "  claude-opus-4-6  ",
      },
    ]);
    expect(prompts.get("g1")).toEqual({
      prompt: "hello",
      model: "claude-opus-4-6",
    });
  });

  test("loadEvents skips corrupt jsonl lines", () => {
    appendEvent(sessionId, {
      type: "note",
      at: "t",
      text: "ok",
    });
    const path = getSession(sessionId)!.eventsPath;
    const existing = readFileSync(path, "utf8");
    appendFileSync(path, "not json\n");
    appendFileSync(path, existing);

    const events = loadEvents(sessionId);
    expect(events.some((e) => e.type === "note")).toBe(true);
  });

  test("viewer claim allows one Ghostty tab opener per session", () => {
    expect(claimViewer(sessionId)).toBe(true);
    expect(claimViewer(sessionId)).toBe(false);
    releaseViewer(sessionId);
    expect(claimViewer(sessionId)).toBe(true);
  });
});
