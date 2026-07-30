import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { globalCursorDir } from "./paths";
import { listSessions } from "./store";

function isGlobalCursorDir(dir: string): boolean {
  return resolve(dir) === resolve(globalCursorDir());
}

function real(path: string): string {
  try {
    if (existsSync(path)) return realpathSync(path);
  } catch {
    // keep resolve()
  }
  return resolve(path);
}

/** True when `cwd` is exactly `workspace` or a directory under it. */
function isInsideWorkspace(cwd: string, workspace: string): boolean {
  const c = real(cwd);
  const w = real(workspace);
  if (c === w) return true;
  const prefix = w.endsWith(sep) ? w : w + sep;
  return c.startsWith(prefix);
}

/**
 * Cursor encodes absolute workspace paths as project folder names by stripping
 * a leading slash and replacing `/` with `-` (one-way; dashes in path segments
 * are ambiguous to decode, so we only encode and check existence).
 */
function cursorProjectId(workspacePath: string): string {
  const abs = resolve(workspacePath);
  if (abs === "/" || abs === "") return "";
  return abs.replace(/^\//, "").replace(/\//g, "-");
}

/** True when Cursor has a projects/ entry for this absolute path. */
function hasCursorProjectEntry(dir: string): boolean {
  const id = cursorProjectId(dir);
  if (!id) return false;
  return existsSync(join(globalCursorDir(), "projects", id));
}

/**
 * Walk from cwd upward (stopping at $HOME) and decide whether this looks like
 * a Cursor project workspace.
 *
 * Signals (strong → weak):
 * 1. A watchty session recorded this path (or an ancestor) as workspace_roots
 * 2. Project-local `.cursor/` (not ~/.cursor) or `.cursorignore`
 * 3. A Cursor `projects/<encoded-path>` entry (covers global-hooks-only repos)
 *
 * Returns the canonical workspace path to filter on, or undefined if cwd is
 * not a Cursor workspace (CLI should then show all sessions).
 */
export function detectCursorWorkspace(cwd = process.cwd()): string | undefined {
  const home = real(homedir());
  let dir = real(cwd);
  const sessionWorkspaces = [
    ...new Set(
      listSessions()
        .map((s) => s.workspace)
        .filter((w): w is string => Boolean(w)),
    ),
  ];

  for (;;) {
    // Only: cwd is the workspace, or cwd is inside the workspace.
    // Never: workspace is inside cwd (that would make $HOME match every project).
    for (const ws of sessionWorkspaces) {
      if (isInsideWorkspace(dir, ws)) return ws;
    }

    if (dir !== home) {
      const cursorDir = join(dir, ".cursor");
      if (existsSync(cursorDir) && !isGlobalCursorDir(cursorDir)) {
        return dir;
      }
      if (existsSync(join(dir, ".cursorignore"))) {
        return dir;
      }
      if (hasCursorProjectEntry(dir)) {
        return dir;
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    if (dir === home) break;
    dir = parent;
  }

  return undefined;
}
