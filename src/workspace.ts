import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { listSessions } from "./store";

function isGlobalCursorDir(dir: string): boolean {
  return resolve(dir) === resolve(join(homedir(), ".cursor"));
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
 * Walk from cwd upward (stopping at $HOME) and decide whether this looks like
 * a Cursor project workspace.
 *
 * Signals (strong → weak):
 * 1. A watchty session recorded this path (or an ancestor) as workspace_roots
 * 2. Project-local `.cursor/` (not ~/.cursor) or `.cursorignore`
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
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    if (dir === home) break;
    dir = parent;
  }

  return undefined;
}
