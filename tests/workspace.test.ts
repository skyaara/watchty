import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { detectCursorWorkspace } from "../src/workspace";
import { resetWatchtyData } from "./helpers";
import { upsertSession } from "../src/store";

const WITH_CURSOR = join(import.meta.dir, "fixtures", "with-cursor");
const HOMES_ROOT = join(import.meta.dir, ".tmp-homes");

/** Mirror of Cursor’s projects/ folder naming (see src/workspace.ts). */
function cursorProjectFolder(workspacePath: string): string {
  return resolve(workspacePath).replace(/^\//, "").replace(/\//g, "-");
}

/**
 * list/view auto-scope to the current Cursor project when possible.
 */
describe("Cursor workspace detection", () => {
  test("detects project-local .cursor directory", () => {
    const sub = join(WITH_CURSOR, "src");
    mkdirSync(sub, { recursive: true });
    expect(detectCursorWorkspace(sub)).toBe(WITH_CURSOR);
    rmSync(sub, { recursive: true, force: true });
  });

  test("does not treat global ~/.cursor as a project workspace", () => {
    const homeCursor = join(homedir(), ".cursor");
    expect(detectCursorWorkspace(homeCursor)).toBeUndefined();
  });

  test("uses recorded session workspace when cwd is inside it", () => {
    resetWatchtyData();
    const projectRoot = join(WITH_CURSOR, "nested");
    mkdirSync(projectRoot, { recursive: true });
    upsertSession("ws-session", {
      title: "t",
      workspace: projectRoot,
    });
    const sub = join(projectRoot, "packages", "api");
    mkdirSync(sub, { recursive: true });
    expect(detectCursorWorkspace(sub)).toBe(projectRoot);
    resetWatchtyData();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("returns undefined outside any known project", () => {
    const outside = join(tmpdir(), `watchty-nowhere-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    try {
      expect(detectCursorWorkspace(outside)).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("detects Cursor projects/ entry without a local .cursor dir", () => {
    resetWatchtyData();
    mkdirSync(HOMES_ROOT, { recursive: true });
    const home = mkdtempSync(join(HOMES_ROOT, "ws-"));
    const cursorDir = join(home, "cursor-config");
    const project = join(home, "Desktop", "oci-k8s-static-portfolio");
    mkdirSync(project, { recursive: true });
    mkdirSync(
      join(cursorDir, "projects", cursorProjectFolder(project)),
      { recursive: true },
    );

    const prev = process.env.WATCHTY_CURSOR_DIR;
    process.env.WATCHTY_CURSOR_DIR = cursorDir;
    try {
      const sub = join(project, "helm");
      mkdirSync(sub, { recursive: true });
      expect(detectCursorWorkspace(sub)).toBe(project);
      expect(detectCursorWorkspace(project)).toBe(project);
    } finally {
      if (prev === undefined) delete process.env.WATCHTY_CURSOR_DIR;
      else process.env.WATCHTY_CURSOR_DIR = prev;
      rmSync(home, { recursive: true, force: true });
      resetWatchtyData();
    }
  });
});
