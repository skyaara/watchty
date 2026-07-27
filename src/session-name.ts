import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { shortId, workspaceWindowTitle } from "./paths";

const CURSOR_STATE_DB = join(
  homedir(),
  "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
);

/**
 * Resolve the Cursor agent/composer session display name for a conversation id.
 * Reads Cursor's composerHeaders table (same name shown in the Agents sidebar).
 */
function lookupComposerName(conversationId: string): string | undefined {
  if (!conversationId || !existsSync(CURSOR_STATE_DB)) return undefined;
  try {
    const db = new Database(CURSOR_STATE_DB, { readonly: true });
    try {
      const row = db
        .query(
          `SELECT value FROM composerHeaders WHERE composerId = ? LIMIT 1`,
        )
        .get(conversationId) as { value?: string } | null;
      if (row?.value) {
        const parsed = JSON.parse(row.value) as { name?: string };
        if (parsed.name && parsed.name.trim()) return parsed.name.trim();
      }

      // Fallback: composerData may include a name in some versions
      const data = db
        .query(
          `SELECT value FROM cursorDiskKV WHERE key = ? LIMIT 1`,
        )
        .get(`composerData:${conversationId}`) as { value?: string } | null;
      if (data?.value) {
        const parsed = JSON.parse(data.value) as { name?: string; title?: string };
        const n = parsed.name ?? parsed.title;
        if (n && n.trim()) return n.trim();
      }
    } finally {
      db.close();
    }
  } catch {
    // DB locked or schema changed — ignore
  }
  return undefined;
}

export function resolveSessionTitle(opts: {
  conversationId: string;
  workspace?: string;
  hint?: string;
}): string {
  const sessionName = (() => {
    if (opts.hint?.trim()) {
      // Strip a leading "workspace | " (or legacy " · ") if we previously composed the title
      const hint = opts.hint.trim();
      if (opts.workspace) {
        const ws = workspaceWindowTitle(opts.workspace);
        for (const sep of [" | ", " · "]) {
          const prefix = `${ws}${sep}`;
          if (hint.startsWith(prefix)) return hint.slice(prefix.length);
        }
      }
      return hint;
    }
    const fromCursor = lookupComposerName(opts.conversationId);
    if (fromCursor) return fromCursor;
    return `agent-${shortId(opts.conversationId)}`;
  })();

  // Ghostty macOS keeps window title === selected tab title, so include
  // workspace in the shared title (window shows workspace; tabs stay distinct).
  if (opts.workspace) {
    const ws = workspaceWindowTitle(opts.workspace);
    return `${ws} | ${sessionName}`;
  }
  return sessionName;
}

/** OSC for surface title (Ghostty mirrors this to tab + window). */
export function setTerminalTitle(title: string): void {
  const clean = title.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120);
  process.stdout.write(`\x1b]0;${clean}\x07`);
  process.stdout.write(`\x1b]2;${clean}\x07`);
}
