import {
  existsSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { ROOT, SESSIONS_DIR, sanitizeId } from "./paths";
import {
  ensureDirs,
  loadState,
  mutateState,
  sessionEventsPath,
  type SessionRecord,
} from "./store";
import { resolvedSettings } from "./config";
import { formatTtl } from "./ttl";

export { parseTtl, formatTtl } from "./ttl";

const LAST_CLEANUP_PATH = join(ROOT, "last-cleanup");
/** Don’t auto-clean more than once per this interval from hooks. */
const AUTO_CLEANUP_MIN_MS = 60 * 60 * 1000;

export type CleanupResult = {
  removed: SessionRecord[];
  kept: number;
  ttlMs: number;
  dryRun: boolean;
};

function sessionAgeAnchor(s: SessionRecord): number {
  const t = Date.parse(s.endedAt ?? s.updatedAt ?? s.createdAt);
  return Number.isFinite(t) ? t : 0;
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
}

/** Remove one session from state + on-disk artifacts. */
function deleteSession(id: string): void {
  ensureDirs();
  let eventsPath = sessionEventsPath(id);
  mutateState((state) => {
    const existing = state.sessions[id];
    if (existing?.eventsPath) eventsPath = existing.eventsPath;
    delete state.sessions[id];
  });
  const sid = sanitizeId(id);

  unlinkQuiet(eventsPath);
  unlinkQuiet(join(SESSIONS_DIR, `${sid}.viewer.lock`));
}

/**
 * Delete sessions whose last activity (endedAt ?? updatedAt) is older than ttlMs.
 * ttlMs <= 0 means delete nothing (disabled).
 */
export function cleanupSessions(opts: {
  ttlMs: number;
  dryRun?: boolean;
  /** If true, also remove orphan jsonl files not in state. */
  orphans?: boolean;
}): CleanupResult {
  const dryRun = Boolean(opts.dryRun);
  const ttlMs = opts.ttlMs;
  const removed: SessionRecord[] = [];
  let kept = 0;

  if (ttlMs <= 0) {
    return {
      removed,
      kept: Object.keys(loadState().sessions).length,
      ttlMs,
      dryRun,
    };
  }

  const cutoff = Date.now() - ttlMs;
  const state = loadState();
  const ids = Object.keys(state.sessions);

  for (const id of ids) {
    const s = state.sessions[id]!;
    if (sessionAgeAnchor(s) < cutoff) {
      removed.push(s);
      if (!dryRun) deleteSession(id);
    } else {
      kept++;
    }
  }

  if (opts.orphans !== false && !dryRun) {
    cleanupOrphanFiles(new Set(Object.keys(loadState().sessions)));
  }

  if (!dryRun) {
    try {
      writeFileSync(LAST_CLEANUP_PATH, new Date().toISOString(), "utf8");
    } catch {
      // ignore
    }
  }

  return { removed, kept, ttlMs, dryRun };
}

/** Drop leftover session files whose id is no longer in state. */
function cleanupOrphanFiles(knownIds: Set<string>): void {
  if (!existsSync(SESSIONS_DIR)) return;
  let names: string[] = [];
  try {
    names = readdirSync(SESSIONS_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^(.+)\.(jsonl|viewer\.lock)$/.exec(name);
    if (!m) continue;
    const sid = m[1]!;
    const stillKnown = [...knownIds].some((id) => sanitizeId(id) === sid);
    if (!stillKnown) unlinkQuiet(join(SESSIONS_DIR, name));
  }
}

/**
 * Throttled cleanup for hooks — uses config ttlHours.
 * No-op when ttl is off or last run was recent.
 */
export function maybeAutoCleanup(): CleanupResult | null {
  const { ttlHours } = resolvedSettings();
  const ttlMs = Math.round(ttlHours * 3_600_000);
  if (ttlMs <= 0) return null;

  if (existsSync(LAST_CLEANUP_PATH)) {
    try {
      const last = Date.parse(readFileSync(LAST_CLEANUP_PATH, "utf8").trim());
      if (Number.isFinite(last) && Date.now() - last < AUTO_CLEANUP_MIN_MS) {
        return null;
      }
    } catch {
      // proceed
    }
  }

  return cleanupSessions({ ttlMs });
}

export function describeCleanup(result: CleanupResult): string {
  const ttl = formatTtl(result.ttlMs);
  const verb = result.dryRun ? "would remove" : "removed";
  if (!result.removed.length) {
    return `cleanup ttl=${ttl}: nothing to remove (${result.kept} kept)`;
  }
  const lines = [
    `cleanup ttl=${ttl}: ${verb} ${result.removed.length}, kept ${result.kept}`,
  ];
  for (const s of result.removed) {
    lines.push(`  - ${s.id.slice(0, 8)}  ${s.title}`);
  }
  return lines.join("\n");
}
