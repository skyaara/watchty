import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { saveConfig } from "../src/config";
import { resetOsascriptRunner, setOsascriptRunner } from "../src/ghostty";
import { handleHook } from "../src/hook";
import { getSession, loadEvents, loadState, upsertSession } from "../src/store";
import { captureStdout, resetWatchtyData } from "./helpers";

describe("Cursor hook payloads", () => {
  const sessionId = "conv-hook-test-001";

  beforeEach(() => {
    resetWatchtyData();
    saveConfig({ autoOpen: true, focus: false, background: true });
    resetOsascriptRunner();
    setOsascriptRunner(() => ({
      ok: true,
      stdout: "tab-1\tterm-1\twin-1",
      stderr: "",
    }));
  });

  afterEach(() => {
    resetWatchtyData();
    resetOsascriptRunner();
  });

  test("sessionStart records workspace but does not open Ghostty yet", async () => {
    await handleHook({
      hook_event_name: "sessionStart",
      conversation_id: sessionId,
      workspace_roots: ["/Users/dev/my-app"],
      title: "Fix login",
    });

    const session = getSession(sessionId);
    expect(session?.title).toContain("Fix login");
    expect(session?.terminalId).toBeUndefined();

    const events = loadEvents(sessionId);
    expect(events[0]).toMatchObject({
      type: "session_start",
      workspace: "/Users/dev/my-app",
    });
  });

  test("beforeSubmitPrompt writes prompt events and opens one viewer tab", async () => {
    await handleHook({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: sessionId,
      generation_id: "gen-1",
      prompt: "run the tests",
      model: "claude-opus-4-6",
      workspace_roots: ["/Users/dev/my-app"],
      title: "Fix login",
    });

    const events = loadEvents(sessionId);
    expect(
      events.some(
        (e) =>
          e.type === "prompt" &&
          e.prompt === "run the tests" &&
          e.model === "claude-opus-4-6",
      ),
    ).toBe(true);

    const session = getSession(sessionId);
    expect(session?.terminalId).toBe("term-1");
    expect(session?.viewerClaimed).toBe(true);
  });

  test("beforeSubmitPrompt falls back to model_id when model is absent", async () => {
    await handleHook({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: sessionId,
      generation_id: "gen-model-id",
      prompt: "hi",
      model_id: "composer-2",
      workspace_roots: ["/Users/dev/my-app"],
    });

    const prompt = loadEvents(sessionId).find((e) => e.type === "prompt");
    expect(prompt).toMatchObject({
      type: "prompt",
      prompt: "hi",
      model: "composer-2",
    });
  });

  test("preToolUse records cmd_start with tool_use_id", async () => {
    await handleHook({
      hook_event_name: "preToolUse",
      conversation_id: sessionId,
      tool_name: "Shell",
      tool_use_id: "tc-shell-1",
      tool_input: { command: "bun test", working_directory: "/Users/dev/my-app" },
      generation_id: "gen-2",
    });

    const start = loadEvents(sessionId).find((e) => e.type === "cmd_start");
    expect(start).toMatchObject({
      type: "cmd_start",
      id: "tc-shell-1",
      command: "bun test",
      cwd: "/Users/dev/my-app",
      generationId: "gen-2",
    });
  });

  test("postToolUse pairs by tool_use_id even when out of FIFO order", async () => {
    await handleHook({
      hook_event_name: "preToolUse",
      conversation_id: sessionId,
      tool_name: "Shell",
      tool_use_id: "cmd-slow",
      tool_input: { command: "sleep 10" },
    });
    await handleHook({
      hook_event_name: "preToolUse",
      conversation_id: sessionId,
      tool_name: "Shell",
      tool_use_id: "cmd-fast",
      tool_input: { command: "echo hi" },
    });

    // Fast command finishes first — must not attach to sleep
    await handleHook({
      hook_event_name: "postToolUse",
      conversation_id: sessionId,
      tool_name: "Shell",
      tool_use_id: "cmd-fast",
      tool_output: JSON.stringify({ exitCode: 0, stdout: "hi\n" }),
      duration: 12,
    });
    await handleHook({
      hook_event_name: "postToolUse",
      conversation_id: sessionId,
      tool_name: "Shell",
      tool_use_id: "cmd-slow",
      tool_output: JSON.stringify({ exitCode: 0, stdout: "" }),
      duration: 10000,
    });

    const events = loadEvents(sessionId);
    const endFast = events.find(
      (e) => e.type === "cmd_end" && e.id === "cmd-fast",
    );
    const endSlow = events.find(
      (e) => e.type === "cmd_end" && e.id === "cmd-slow",
    );
    expect(endFast).toMatchObject({
      type: "cmd_end",
      exitCode: 0,
      output: "hi\n",
      durationMs: 12,
    });
    expect(endSlow).toMatchObject({
      type: "cmd_end",
      exitCode: 0,
      output: "",
      durationMs: 10000,
    });
  });

  test("postToolUseFailure ends the matching tool_use_id", async () => {
    await handleHook({
      hook_event_name: "preToolUse",
      conversation_id: sessionId,
      tool_name: "Shell",
      tool_use_id: "cmd-fail",
      tool_input: { command: "false" },
    });
    await handleHook({
      hook_event_name: "postToolUseFailure",
      conversation_id: sessionId,
      tool_name: "Shell",
      tool_use_id: "cmd-fail",
      error_message: "Command timed out after 30s",
      failure_type: "timeout",
      duration: 5000,
    });

    expect(loadEvents(sessionId).find((e) => e.type === "cmd_end")).toMatchObject({
      id: "cmd-fail",
      exitCode: 1,
      output: "Command timed out after 30s",
      durationMs: 5000,
    });
  });

  test("preToolUse ignores non-Shell tools", async () => {
    await handleHook({
      hook_event_name: "preToolUse",
      conversation_id: sessionId,
      tool_name: "Read",
      tool_use_id: "tc-read",
      tool_input: { path: "README.md" },
    });
    expect(loadEvents(sessionId)).toHaveLength(0);
  });

  test("autoOpen=false still writes events without opening Ghostty", async () => {
    saveConfig({ autoOpen: false });
    resetOsascriptRunner();
    let osascriptCalls = 0;
    setOsascriptRunner(() => {
      osascriptCalls++;
      return { ok: true, stdout: "tab\tterm\twin", stderr: "" };
    });

    await handleHook({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: sessionId,
      prompt: "hello",
      generation_id: "g1",
    });

    expect(osascriptCalls).toBe(0);
    expect(getSession(sessionId)?.terminalId).toBeUndefined();
    expect(loadEvents(sessionId).length).toBeGreaterThan(0);
  });

  test("Ghostty open failure writes a note with manual view command", async () => {
    setOsascriptRunner(() => ({
      ok: true,
      stdout: "ERR\tpermission denied",
      stderr: "",
    }));

    await handleHook({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: sessionId,
      prompt: "go",
      generation_id: "g1",
    });

    const note = loadEvents(sessionId).find((e) => e.type === "note");
    expect(note?.text).toContain("Ghostty tab failed");
    expect(note?.text).toContain("view");
    expect(getSession(sessionId)?.terminalId).toBeUndefined();
  });

  test("ignores payloads without conversation_id", async () => {
    await handleHook({ hook_event_name: "sessionStart" });
    expect(Object.keys(loadState().sessions)).toHaveLength(0);
  });

  test("sessionEnd and stop mark endedAt and write session_end", async () => {
    await handleHook({
      hook_event_name: "sessionStart",
      conversation_id: sessionId,
      title: "Wrap up",
    });

    await handleHook({
      hook_event_name: "sessionEnd",
      conversation_id: sessionId,
    });

    const session = getSession(sessionId);
    expect(session?.endedAt).toBeDefined();
    expect(loadEvents(sessionId).some((e) => e.type === "session_end")).toBe(
      true,
    );

    const stopId = "conv-stop-002";
    await handleHook({
      hook_event_name: "stop",
      conversation_id: stopId,
      title: "Stopped",
    });
    expect(getSession(stopId)?.endedAt).toBeDefined();
    expect(loadEvents(stopId).some((e) => e.type === "session_end")).toBe(true);
  });

  test("preToolUse opens a tab when prompt hook never ran", async () => {
    await handleHook({
      hook_event_name: "preToolUse",
      conversation_id: sessionId,
      tool_name: "Shell",
      tool_use_id: "tc-open",
      tool_input: { command: "bun test", working_directory: "/Users/dev/my-app" },
      generation_id: "gen-shell",
    });

    expect(getSession(sessionId)?.terminalId).toBe("term-1");
    expect(loadEvents(sessionId).some((e) => e.type === "cmd_start")).toBe(
      true,
    );
  });

  test("reclaims and reopens when the previous Ghostty terminal is dead", async () => {
    upsertSession(sessionId, {
      title: "Dead tab",
      terminalId: "term-dead",
      tabId: "tab-dead",
      viewerClaimed: true,
    });

    setOsascriptRunner((script) => {
      if (script.includes("every terminal whose id is")) {
        return { ok: true, stdout: "no", stderr: "" };
      }
      return { ok: true, stdout: "tab-2\tterm-2\twin-2", stderr: "" };
    });

    await handleHook({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: sessionId,
      prompt: "retry",
      generation_id: "g-retry",
    });

    expect(getSession(sessionId)?.terminalId).toBe("term-2");
  });

  test("writes continue / permission JSON on prompt and shell tool hooks", async () => {
    const promptOut = await captureStdout(() =>
      handleHook({
        hook_event_name: "beforeSubmitPrompt",
        conversation_id: sessionId,
        prompt: "hi",
        generation_id: "g1",
      }),
    );
    expect(JSON.parse(promptOut.trim())).toEqual({ continue: true });

    const shellOut = await captureStdout(() =>
      handleHook({
        hook_event_name: "preToolUse",
        conversation_id: sessionId,
        tool_name: "Shell",
        tool_use_id: "tc-perm",
        tool_input: { command: "true" },
      }),
    );
    expect(JSON.parse(shellOut.trim())).toEqual({
      permission: "allow",
    });
  });
});
