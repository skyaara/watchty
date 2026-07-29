import { describe, expect, test } from "bun:test";
import { resolveSessionTitle } from "../src/session-name";

/**
 * Ghostty tab titles should identify both project and chat name
 * (README: `repo | Fix login`).
 */
describe("Ghostty tab titles", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  test("prefixes workspace folder when known", () => {
    expect(
      resolveSessionTitle({
        conversationId: id,
        workspace: "/Users/dev/my-app",
        hint: "Fix login",
      }),
    ).toBe("my-app | Fix login");
  });

  test("uses chat hint without Cursor database", () => {
    expect(
      resolveSessionTitle({
        conversationId: id,
        hint: "Refactor auth",
      }),
    ).toBe("Refactor auth");
  });

  test("falls back to short agent id when no name is available", () => {
    expect(resolveSessionTitle({ conversationId: id })).toBe("agent-aaaaaaaa");
  });

  test("strips duplicate workspace prefix from stored hints", () => {
    expect(
      resolveSessionTitle({
        conversationId: id,
        workspace: "/Users/dev/my-app",
        hint: "my-app | Fix login",
      }),
    ).toBe("my-app | Fix login");
  });
});
