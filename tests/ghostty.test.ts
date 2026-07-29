import { afterEach, describe, expect, test } from "bun:test";
import {
  openSessionTab,
  resetOsascriptRunner,
  setOsascriptRunner,
  terminalAlive,
} from "../src/ghostty";

describe("Ghostty osascript responses", () => {
  afterEach(() => resetOsascriptRunner());

  test("openSessionTab parses tab ids from osascript stdout", () => {
    setOsascriptRunner(() => ({
      ok: true,
      stdout: "tab1\tterm1\twin1",
      stderr: "",
    }));

    expect(
      openSessionTab({ command: "watchty view abc", title: "Fix login" }),
    ).toEqual({
      ok: true,
      tabId: "tab1",
      terminalId: "term1",
      windowId: "win1",
    });
  });

  test("openSessionTab returns an error when Ghostty reports failure", () => {
    setOsascriptRunner(() => ({
      ok: true,
      stdout: "ERR\tGhostty not running",
      stderr: "",
    }));

    expect(openSessionTab({ command: "x", title: "t" })).toEqual({
      ok: false,
      error: "Ghostty not running",
    });
  });

  test("terminalAlive is false without a terminal id", () => {
    expect(terminalAlive()).toBe(false);
    expect(terminalAlive("")).toBe(false);
  });
});
