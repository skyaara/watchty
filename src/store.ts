import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { STATE_PATH, SESSIONS_DIR, shortId, sanitizeId } from "./paths";

export type SessionRecord = {
  id: string;
  title: string;
  eventsPath: string;
  tabId?: string;
  terminalId?: string;
  windowId?: string;
  /** Ghostty terminal id for the interactive shell split (main pane) */
  shellTerminalId?: string;
  workspace?: string;
  viewerClaimed?: boolean;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

export type StateFile = {
  version: 1;
  sessions: Record<string, SessionRecord>;
};

export type SessionEvent =
  | {
      type: "session_start";
      at: string;
      title: string;
      workspace?: string;
    }
  | {
      type: "cmd_start";
      id: string;
      at: string;
      command: string;
      cwd?: string;
      /** Cursor generation / agent turn — groups commands from one prompt */
      generationId?: string;
    }
  | {
      type: "cmd_end";
      id: string;
      at: string;
      exitCode?: number | null;
      durationMs?: number;
      output?: string;
    }
  | {
      type: "session_end";
      at: string;
    }
  | {
      type: "note";
      at: string;
      text: string;
    };

export type CommandRow = {
  id: string;
  command: string;
  cwd?: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  durationMs?: number;
  output: string;
  running: boolean;
  generationId?: string;
};

function emptyState(): StateFile {
  return { version: 1, sessions: {} };
}

export function sessionEventsPath(id: string): string {
  return join(SESSIONS_DIR, `${sanitizeId(id)}.jsonl`);
}

function claimPath(id: string): string {
  return join(SESSIONS_DIR, `${sanitizeId(id)}.viewer.lock`);
}

function pendingPath(id: string): string {
  return join(SESSIONS_DIR, `${sanitizeId(id)}.pending`);
}

export function ensureDirs(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function loadState(): StateFile {
  ensureDirs();
  if (!existsSync(STATE_PATH)) return emptyState();
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as StateFile;
    if (!parsed.sessions) return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}

export function saveState(state: StateFile): void {
  ensureDirs();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function getSession(id: string): SessionRecord | undefined {
  return loadState().sessions[id];
}

export function upsertSession(
  id: string,
  patch: Partial<Omit<SessionRecord, "id" | "eventsPath" | "createdAt">> & {
    workspace?: string;
  },
): SessionRecord {
  const state = loadState();
  const now = new Date().toISOString();
  const existing = state.sessions[id];
  const record: SessionRecord = existing
    ? {
        ...existing,
        ...patch,
        eventsPath: existing.eventsPath ?? sessionEventsPath(id),
        updatedAt: now,
      }
    : {
        id,
        title: patch.title ?? `agent-${shortId(id)}`,
        eventsPath: sessionEventsPath(id),
        workspace: patch.workspace,
        tabId: patch.tabId,
        terminalId: patch.terminalId,
        windowId: patch.windowId,
        viewerClaimed: patch.viewerClaimed,
        createdAt: now,
        updatedAt: now,
        endedAt: patch.endedAt,
      };

  if (!existsSync(record.eventsPath)) writeFileSync(record.eventsPath, "", "utf8");

  state.sessions[id] = record;
  saveState(state);
  return record;
}

export function listSessions(): SessionRecord[] {
  const sessions = Object.values(loadState().sessions);
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function appendEvent(id: string, event: SessionEvent): string {
  const record = upsertSession(id, {});
  appendFileSync(record.eventsPath, JSON.stringify(event) + "\n", "utf8");
  upsertSession(id, {});
  return record.eventsPath;
}

/**
 * Claim exclusive right to open the Ghostty viewer for this session.
 * Returns false if another hook already claimed it (prevents duplicate tabs).
 */
export function claimViewer(id: string): boolean {
  ensureDirs();
  upsertSession(id, {});
  try {
    const fd = openSync(claimPath(id), "wx");
    closeSync(fd);
    upsertSession(id, { viewerClaimed: true });
    return true;
  } catch {
    upsertSession(id, { viewerClaimed: true });
    return false;
  }
}

/** Drop viewer claim + Ghostty ids so a closed tab can be reopened. */
export function releaseViewer(id: string): void {
  try {
    unlinkSync(claimPath(id));
  } catch {
    // lock may already be gone
  }
  const state = loadState();
  const existing = state.sessions[id];
  if (!existing) return;
  existing.viewerClaimed = false;
  existing.tabId = undefined;
  existing.terminalId = undefined;
  existing.windowId = undefined;
  existing.shellTerminalId = undefined;
  existing.updatedAt = new Date().toISOString();
  state.sessions[id] = existing;
  saveState(state);
}

export function setPendingCmd(sessionId: string, cmdId: string): void {
  ensureDirs();
  writeFileSync(pendingPath(sessionId), cmdId, "utf8");
}

export function takePendingCmd(sessionId: string): string | undefined {
  const p = pendingPath(sessionId);
  if (!existsSync(p)) return undefined;
  try {
    const id = readFileSync(p, "utf8").trim();
    writeFileSync(p, "", "utf8");
    return id || undefined;
  } catch {
    return undefined;
  }
}

export function loadEvents(id: string): SessionEvent[] {
  const path = getSession(id)?.eventsPath ?? sessionEventsPath(id);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const events: SessionEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as SessionEvent);
    } catch {
      // skip bad line
    }
  }
  return events;
}

export function eventsToCommands(events: SessionEvent[]): CommandRow[] {
  const map = new Map<string, CommandRow>();
  const order: string[] = [];

  for (const ev of events) {
    if (ev.type === "cmd_start") {
      if (!map.has(ev.id)) order.push(ev.id);
      map.set(ev.id, {
        id: ev.id,
        command: ev.command,
        cwd: ev.cwd,
        startedAt: ev.at,
        output: "",
        running: true,
        generationId: ev.generationId,
      });
    } else if (ev.type === "cmd_end") {
      const row = map.get(ev.id);
      if (row) {
        row.endedAt = ev.at;
        row.exitCode = ev.exitCode;
        row.durationMs = ev.durationMs;
        row.output = ev.output ?? "";
        row.running = false;
      } else {
        order.push(ev.id);
        map.set(ev.id, {
          id: ev.id,
          command: "(command)",
          startedAt: ev.at,
          endedAt: ev.at,
          exitCode: ev.exitCode,
          durationMs: ev.durationMs,
          output: ev.output ?? "",
          running: false,
        });
      }
    }
  }

  return order.map((id) => map.get(id)!).filter(Boolean);
}

export function resolveWorkspace(roots?: string[]): string | undefined {
  if (!roots?.length) return undefined;
  return roots[0];
}
