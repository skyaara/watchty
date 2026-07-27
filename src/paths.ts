import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const NEW_ROOT = join(HOME, ".cursor", "watchty");
/** Pre-rename data dir — used if watchty/ does not exist yet. */
const LEGACY_ROOT = join(HOME, ".cursor", "agent-ghostty");

/**
 * Prefer ~/.cursor/watchty. If only the legacy agent-ghostty dir exists,
 * keep using it so local installs don’t lose sessions.
 */
export const ROOT =
  existsSync(NEW_ROOT) || !existsSync(LEGACY_ROOT) ? NEW_ROOT : LEGACY_ROOT;

export const STATE_PATH = join(ROOT, "state.json");
export const SESSIONS_DIR = join(ROOT, "sessions");

/** Basename of a workspace path for Ghostty window titles. */
export function workspaceWindowTitle(workspace?: string): string {
  if (!workspace) return "Cursor Agent";
  const base = workspace.split("/").filter(Boolean).pop();
  return base || workspace;
}

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
