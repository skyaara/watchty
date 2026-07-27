import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  renameSync,
  statSync,
  writeSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { ROOT, STATE_PATH, SESSIONS_DIR, shortId, sanitizeId, workspaceMatches } from "./paths";

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

/** Ghostty open should finish well under this; after that, steal the claim. */
const VIEWER_CLAIM_STALE_MS = 15_000;
const STATE_LOCK_STALE_MS = 10_000;
const STATE_LOCK_WAIT_MS = 15_000;
const PENDING_LOCK_STALE_MS = 5_000;
const PENDING_LOCK_WAIT_MS = 8_000;

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

function pendingLockPath(id: string): string {
  return join(SESSIONS_DIR, `${sanitizeId(id)}.pending.lock`);
}

function stateLockPath(): string {
  return join(ROOT, "state.lock");
}

export function ensureDirs(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sleepMs(ms: number): void {
  Bun.sleepSync(ms);
}

/**
 * Exclusive create of a lock file with retry + stale takeover.
 * Returns an open fd that must be released via releaseFileLock.
 */
function acquireFileLock(
  lockPath: string,
  opts: { waitMs: number; staleMs: number },
): number {
  const deadline = Date.now() + opts.waitMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, `${process.pid}\n${Date.now()}\n`);
      } catch {
        // best-effort metadata
      }
      return fd;
    } catch (err) {
      lastErr = err;
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : "";
      // Only EEXIST means another holder; anything else is a hard failure.
      if (code && code !== "EEXIST") {
        throw err;
      }
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > opts.staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // lock disappeared — retry
      }
      sleepMs(10);
    }
  }
  throw new Error(
    `timed out acquiring lock: ${lockPath}${lastErr ? ` (${String(lastErr)})` : ""}`,
  );
}

function releaseFileLock(lockPath: string, fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // ignore
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

function loadStateUnlocked(): StateFile {
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

/** Atomic replace of state.json (same-filesystem rename). */
function atomicSaveState(state: StateFile): void {
  ensureDirs();
  const tmp = join(ROOT, `state.json.tmp.${process.pid}.${Date.now()}`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, STATE_PATH);
}

/**
 * Read-modify-write state.json under an exclusive lock.
 * Prefer this over loadState + saveState for any mutation.
 */
export function mutateState(fn: (state: StateFile) => void): StateFile {
  ensureDirs();
  const lock = stateLockPath();
  const fd = acquireFileLock(lock, {
    waitMs: STATE_LOCK_WAIT_MS,
    staleMs: STATE_LOCK_STALE_MS,
  });
  try {
    const state = loadStateUnlocked();
    fn(state);
    atomicSaveState(state);
    return state;
  } finally {
    releaseFileLock(lock, fd);
  }
}

export function loadState(): StateFile {
  ensureDirs();
  return loadStateUnlocked();
}

/** Atomic write. Callers doing read-modify-write should use mutateState instead. */
export function saveState(state: StateFile): void {
  ensureDirs();
  const lock = stateLockPath();
  const fd = acquireFileLock(lock, {
    waitMs: STATE_LOCK_WAIT_MS,
    staleMs: STATE_LOCK_STALE_MS,
  });
  try {
    atomicSaveState(state);
  } finally {
    releaseFileLock(lock, fd);
  }
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
  let record!: SessionRecord;
  mutateState((state) => {
    const now = new Date().toISOString();
    const existing = state.sessions[id];
    record = existing
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

    if (!existsSync(record.eventsPath)) {
      writeFileSync(record.eventsPath, "", "utf8");
    }

    state.sessions[id] = record;
  });
  return record;
}

export function listSessions(opts?: {
  /** Filter by workspace path, basename, or `.` (cwd). */
  workspace?: string;
}): SessionRecord[] {
  let sessions = Object.values(loadState().sessions);
  if (opts?.workspace) {
    const q = opts.workspace;
    sessions = sessions.filter((s) => workspaceMatches(s.workspace, q));
  }
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
 * Stale locks (crashed mid-open) are stolen after VIEWER_CLAIM_STALE_MS.
 */
export function claimViewer(id: string): boolean {
  ensureDirs();
  upsertSession(id, {});
  const path = claimPath(id);

  const tryCreate = (): boolean => {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, `${process.pid}\n${Date.now()}\n`);
      } catch {
        // best-effort
      }
      closeSync(fd);
      upsertSession(id, { viewerClaimed: true });
      return true;
    } catch {
      return false;
    }
  };

  if (tryCreate()) return true;

  // Lock held — only steal if stale (crashed hook), never mark claimed on loss.
  try {
    const st = statSync(path);
    if (Date.now() - st.mtimeMs > VIEWER_CLAIM_STALE_MS) {
      try {
        unlinkSync(path);
      } catch {
        return false;
      }
      return tryCreate();
    }
  } catch {
    // lock gone — one more try
    return tryCreate();
  }

  return false;
}

/** Drop viewer claim + Ghostty ids so a closed tab can be reopened. */
export function releaseViewer(id: string): void {
  try {
    unlinkSync(claimPath(id));
  } catch {
    // lock may already be gone
  }
  mutateState((state) => {
    const existing = state.sessions[id];
    if (!existing) return;
    existing.viewerClaimed = false;
    existing.tabId = undefined;
    existing.terminalId = undefined;
    existing.windowId = undefined;
    existing.shellTerminalId = undefined;
    existing.updatedAt = new Date().toISOString();
    state.sessions[id] = existing;
  });
}

function withPendingLock<T>(sessionId: string, fn: () => T): T {
  ensureDirs();
  const lock = pendingLockPath(sessionId);
  const fd = acquireFileLock(lock, {
    waitMs: PENDING_LOCK_WAIT_MS,
    staleMs: PENDING_LOCK_STALE_MS,
  });
  try {
    return fn();
  } finally {
    releaseFileLock(lock, fd);
  }
}

/** Push a command id onto the per-session FIFO (supports overlapping shells). */
export function setPendingCmd(sessionId: string, cmdId: string): void {
  withPendingLock(sessionId, () => {
    const p = pendingPath(sessionId);
    let prefix = "";
    if (existsSync(p)) {
      prefix = readFileSync(p, "utf8");
      // Migrate legacy single-id files that lacked a trailing newline.
      if (prefix && !prefix.endsWith("\n")) prefix += "\n";
    }
    writeFileSync(p, `${prefix}${cmdId}\n`, "utf8");
  });
}

/** Pop the oldest pending command id (FIFO). */
export function takePendingCmd(sessionId: string): string | undefined {
  return withPendingLock(sessionId, () => {
    const p = pendingPath(sessionId);
    if (!existsSync(p)) return undefined;
    try {
      const lines = readFileSync(p, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) return undefined;
      const [first, ...rest] = lines;
      writeFileSync(p, rest.length ? `${rest.join("\n")}\n` : "", "utf8");
      return first;
    } catch {
      return undefined;
    }
  });
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
