import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, normalize, resolve } from "node:path";

const HOME = homedir();

function resolveRoot(): string {
  const fromEnv = process.env.WATCHTY_ROOT?.trim();
  if (fromEnv) return resolve(fromEnv);
  return join(HOME, ".cursor", "watchty");
}

export const ROOT = resolveRoot();

export const STATE_PATH = join(ROOT, "state.json");
export const SESSIONS_DIR = join(ROOT, "sessions");

/** ~/.cursor, or WATCHTY_CURSOR_DIR for tests / alternate installs. */
export function globalCursorDir(): string {
  return process.env.WATCHTY_CURSOR_DIR?.trim() || join(homedir(), ".cursor");
}

/** Basename of a workspace path for Ghostty window titles. */
export function workspaceWindowTitle(workspace?: string): string {
  if (!workspace) return "Cursor Agent";
  const base = workspace.split("/").filter(Boolean).pop();
  return base || workspace;
}

/** Resolve `.` / relative paths; best-effort realpath. */
function resolveWorkspaceQuery(query: string): string {
  const raw = query.trim();
  if (!raw || raw === ".") return process.cwd();
  const withHome = raw.replace(/^~(?=\/|$)/, HOME);
  const abs = resolve(withHome);
  try {
    if (existsSync(abs)) return realpathSync(abs);
  } catch {
    // keep abs
  }
  return abs;
}

/**
 * Match a session workspace path against a user query:
 * `.` / path, basename (`my-app`), or case-insensitive substring.
 */
export function workspaceMatches(
  sessionWorkspace: string | undefined,
  query: string,
): boolean {
  if (!query.trim()) return true;
  if (!sessionWorkspace) return false;

  const qRaw = query.trim();
  const looksLikePath =
    qRaw === "." ||
    qRaw.startsWith("/") ||
    qRaw.startsWith("~") ||
    qRaw.includes("/");
  const qResolved = looksLikePath ? resolveWorkspaceQuery(qRaw) : qRaw;

  const ws = (() => {
    try {
      return existsSync(sessionWorkspace)
        ? realpathSync(sessionWorkspace)
        : normalize(sessionWorkspace);
    } catch {
      return normalize(sessionWorkspace);
    }
  })();

  const wsLower = ws.toLowerCase();
  const qLower = qResolved.toLowerCase();
  const wsBase = basename(ws).toLowerCase();
  const qBase = basename(qResolved).toLowerCase();

  if (wsLower === qLower) return true;
  if (wsLower.startsWith(qLower + "/") || qLower.startsWith(wsLower + "/")) {
    return true;
  }
  if (wsBase === qLower || wsBase === qBase) return true;
  if (wsLower.includes(qLower) || wsBase.includes(qLower)) return true;
  return false;
}

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
