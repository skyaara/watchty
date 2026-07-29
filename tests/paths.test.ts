import { describe, expect, test } from "bun:test";
import {
  sanitizeId,
  shortId,
  workspaceMatches,
  workspaceWindowTitle,
} from "../src/paths";

/**
 * Session files and workspace filters must survive real-world paths and ids.
 */
describe("session identity and workspace filtering", () => {
  test("sanitizes conversation ids into safe filenames", () => {
    expect(sanitizeId("abc-123")).toBe("abc-123");
    expect(sanitizeId("foo/bar:baz")).toBe("foo_bar_baz");
    expect(sanitizeId("weird id!@#")).toBe("weird_id___");
  });

  test("shortens ids for fallback tab titles", () => {
    expect(shortId("abcdefgh")).toBe("abcdefgh");
    expect(shortId("conversation-uuid-long")).toBe("conversa");
  });

  test("uses project folder name in Ghostty window titles", () => {
    expect(workspaceWindowTitle("/Users/dev/my-app")).toBe("my-app");
    expect(workspaceWindowTitle(undefined)).toBe("Cursor Agent");
  });

  describe("workspace filter (-w / auto-scope)", () => {
    const ws = "/Users/dev/my-app";

    test("empty filter matches everything", () => {
      expect(workspaceMatches(ws, "")).toBe(true);
      expect(workspaceMatches(undefined, "")).toBe(true);
    });

    test("missing session workspace never matches a filter", () => {
      expect(workspaceMatches(undefined, "my-app")).toBe(false);
    });

    test("matches exact path, basename, and substrings", () => {
      expect(workspaceMatches(ws, ws)).toBe(true);
      expect(workspaceMatches(ws, "my-app")).toBe(true);
      expect(workspaceMatches(ws, "my-ap")).toBe(true);
    });

    test("does not match unrelated projects", () => {
      expect(workspaceMatches(ws, "other-app")).toBe(false);
      expect(workspaceMatches("/Users/dev/other", "my-app")).toBe(false);
    });

    test("resolves . to the current working directory", () => {
      expect(workspaceMatches(process.cwd(), ".")).toBe(true);
      expect(workspaceMatches("/Users/dev/other", ".")).toBe(false);
    });

    test("expands ~ in path filters", () => {
      const home = process.env.HOME;
      if (!home) return;
      const underHome = `${home}/Projects/demo-app`;
      expect(workspaceMatches(underHome, "~/Projects/demo-app")).toBe(true);
      expect(workspaceMatches(underHome, "~/Projects")).toBe(true);
    });
  });
});
