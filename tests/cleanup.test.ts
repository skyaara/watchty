import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupSessions,
  describeCleanup,
  maybeAutoCleanup,
} from "../src/cleanup";
import { saveConfig } from "../src/config";
import { ROOT, SESSIONS_DIR } from "../src/paths";
import { resetWatchtyData } from "./helpers";
import {
  getSession,
  sessionEventsPath,
  upsertSession,
} from "../src/store";

/**
 * Old session logs should be pruned by age (README: default 7d, manual cleanup).
 */
describe("session cleanup by age", () => {
  beforeEach(() => resetWatchtyData());
  afterEach(() => resetWatchtyData());

  test("does nothing when retention is disabled", () => {
    upsertSession("keep-me", { title: "live" });
    const result = cleanupSessions({ ttlMs: 0 });
    expect(result.removed).toHaveLength(0);
    expect(getSession("keep-me")).toBeDefined();
  });

  test("removes sessions older than the TTL", () => {
    const old = "old-session";
    upsertSession(old, { title: "stale" });
    const path = sessionEventsPath(old);
    const record = getSession(old)!;
    record.endedAt = "2020-01-01T00:00:00.000Z";
    record.updatedAt = "2020-01-01T00:00:00.000Z";
    upsertSession(old, record);

    const result = cleanupSessions({ ttlMs: 24 * 3_600_000 });
    expect(result.removed.map((s) => s.id)).toContain(old);
    expect(getSession(old)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  test("dry-run reports without deleting", () => {
    const id = "dry-run";
    upsertSession(id, { title: "stale" });
    upsertSession(id, {
      endedAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });

    const result = cleanupSessions({ ttlMs: 60_000, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.removed).toHaveLength(1);
    expect(getSession(id)).toBeDefined();
  });

  test("prefers endedAt over updatedAt for age", () => {
    const id = "recent-end";
    upsertSession(id, { title: "done" });
    upsertSession(id, {
      updatedAt: "2020-01-01T00:00:00.000Z",
      endedAt: new Date().toISOString(),
    });

    const result = cleanupSessions({ ttlMs: 60_000 });
    expect(result.removed).toHaveLength(0);
    expect(getSession(id)).toBeDefined();
  });

  test("removes orphan session files not present in state", () => {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const orphanJsonl = join(SESSIONS_DIR, "orphan-gone.jsonl");
    const orphanLock = join(SESSIONS_DIR, "orphan-gone.viewer.lock");
    writeFileSync(orphanJsonl, "{}\n");
    writeFileSync(orphanLock, "1");

    upsertSession("keep-alive", { title: "live" });
    cleanupSessions({ ttlMs: 60_000, orphans: true });

    expect(existsSync(orphanJsonl)).toBe(false);
    expect(existsSync(orphanLock)).toBe(false);
    expect(getSession("keep-alive")).toBeDefined();
  });

  test("describeCleanup reports dry-run and empty results", () => {
    expect(
      describeCleanup({
        removed: [],
        kept: 3,
        ttlMs: 3_600_000,
        dryRun: false,
      }),
    ).toContain("nothing to remove (3 kept)");

    const text = describeCleanup({
      removed: [
        {
          id: "abcdefghij",
          title: "Stale chat",
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
      kept: 1,
      ttlMs: 86_400_000,
      dryRun: true,
    });
    expect(text).toContain("would remove 1");
    expect(text).toContain("abcdefg");
    expect(text).toContain("Stale chat");
  });

  test("maybeAutoCleanup respects ttl off and throttle file", () => {
    saveConfig({ ttlHours: 0 });
    expect(maybeAutoCleanup()).toBeNull();

    saveConfig({ ttlHours: 24 });
    writeFileSync(join(ROOT, "last-cleanup"), new Date().toISOString());
    expect(maybeAutoCleanup()).toBeNull();

    writeFileSync(
      join(ROOT, "last-cleanup"),
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    );
    upsertSession("ancient", {
      title: "gone",
      endedAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    const result = maybeAutoCleanup();
    expect(result?.removed.map((s) => s.id)).toContain("ancient");
  });
});
