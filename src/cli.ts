#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATH, loadConfig, saveConfig, type WatchtyConfig } from "./config";
import {
  cleanupSessions,
  describeCleanup,
  formatTtl,
  parseTtl,
} from "./cleanup";
import { ghosttyAvailable, focusSessionTab } from "./ghostty";
import { handleHook, packageRoot, readHookPayload, selfBin } from "./hook";
import { ROOT, STATE_PATH, SESSIONS_DIR } from "./paths";
import { getSession, listSessions } from "./store";
import { viewSession } from "./view";

const HELP = `watchty — watch Cursor Agent shell commands in Ghostty tabs

Usage:
  watchty hook              Read Cursor hook JSON from stdin
  watchty view [title|id]   Follow a session (omit = latest live)
  watchty list              List known sessions
  watchty focus <title|id>  Focus the Ghostty tab for a session
  watchty cleanup [--ttl <dur>] [--dry-run]
  watchty config            Show ~/.cursor/watchty/config.json
  watchty config set <k> <v>
  watchty install-hooks     Write ~/.cursor/hooks.json with absolute binary path
  watchty doctor            Check install / Ghostty / hooks
  watchty help

Config keys (also via env; env wins):
  autoOpen     true|false   Open Ghostty from hooks (default true)
  background   true|false   Open without stealing app focus (default true)
  focus        true|false   Switch to the new session tab (default false)
  ttl / ttlHours  7d|24h|0  Auto-delete old session logs (default 7d; 0 = off)

Ghostty auto-open is the primary UX. Pull mode works in any terminal:
  watchty config set autoOpen false
  watchty list
  watchty view "Fix login"

Cleanup:
  watchty config set ttl 7d
  watchty cleanup              # use configured TTL
  watchty cleanup --ttl 24h    # one-off
  watchty cleanup --dry-run
`;

function hooksCommand(): string {
  const linked = Bun.which("watchty");
  if (linked) return `${linked} hook`;
  return `${selfBin()} hook`;
}

function buildHooksJson(): object {
  const command = hooksCommand();
  const entry = [{ command }];
  return {
    version: 1,
    hooks: {
      sessionStart: entry,
      beforeShellExecution: entry,
      afterShellExecution: entry,
      sessionEnd: entry,
    },
  };
}

function getSessionByPrefix(prefix: string) {
  if (getSession(prefix)) return getSession(prefix);
  const sessions = listSessions();
  const idMatches = sessions.filter((s) => s.id.startsWith(prefix));
  if (idMatches.length === 1) return idMatches[0];

  // Match Cursor agent / tab title (case-insensitive substring).
  const q = prefix.trim().toLowerCase();
  if (!q) return undefined;
  const titleMatches = sessions.filter((s) => {
    const t = s.title.toLowerCase();
    const name = t.includes(" | ") ? t.slice(t.lastIndexOf(" | ") + 3) : t;
    return t.includes(q) || name.includes(q);
  });
  return titleMatches.length === 1 ? titleMatches[0] : undefined;
}

function titleMatches(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return listSessions().filter((s) => {
    const t = s.title.toLowerCase();
    const name = t.includes(" | ") ? t.slice(t.lastIndexOf(" | ") + 3) : t;
    return t.includes(q) || name.includes(q);
  });
}

/** Most recently updated session that has not ended (or any latest if none live). */
function latestSession() {
  const sessions = listSessions();
  const live = sessions.find((s) => !s.endedAt);
  return live ?? sessions[0];
}

function parseBool(v: string): boolean | undefined {
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

async function cmdList(): Promise<void> {
  const sessions = listSessions();
  if (!sessions.length) {
    console.log("No sessions yet. Run an Agent chat with hooks installed.");
    return;
  }
  for (const s of sessions) {
    const ended = s.endedAt ? "ended" : "live ";
    const name = s.title.includes(" | ")
      ? s.title.slice(s.title.lastIndexOf(" | ") + 3)
      : s.title;
    console.log(`${ended}  ${name}`);
    console.log(`        ${s.title}  ·  ${s.id.slice(0, 8)}`);
  }
  console.log("\nAttach: watchty view \"<title substring>\"");
}

async function cmdView(idArg?: string): Promise<void> {
  if (idArg) {
    const session = getSessionByPrefix(idArg);
    if (!session) {
      const matches = titleMatches(idArg);
      if (matches.length > 1) {
        console.error(`Multiple sessions match "${idArg}":`);
        for (const s of matches) {
          console.error(`  ${s.id.slice(0, 8)}  ${s.title}`);
        }
        process.exitCode = 1;
        return;
      }
      console.error(`No session matching "${idArg}". Try: watchty list`);
      process.exitCode = 1;
      return;
    }
    console.error(`viewing ${session.title}`);
    await viewSession(session.id);
    return;
  }
  const latest = latestSession();
  if (!latest) {
    console.error(
      "No sessions yet. Run an Agent chat with hooks installed, then:\n" +
        "  watchty list\n" +
        "  watchty view \"<agent title>\"",
    );
    process.exitCode = 1;
    return;
  }
  console.error(`viewing ${latest.title}`);
  await viewSession(latest.id);
}

async function cmdFocus(query: string): Promise<void> {
  const session = getSessionByPrefix(query);
  if (!session) {
    const matches = titleMatches(query);
    if (matches.length > 1) {
      console.error(`Multiple sessions match "${query}":`);
      for (const s of matches) {
        console.error(`  ${s.id.slice(0, 8)}  ${s.title}`);
      }
      process.exitCode = 1;
      return;
    }
    console.error(`Unknown session: ${query}`);
    process.exitCode = 1;
    return;
  }
  const result = focusSessionTab(session);
  if (!result.ok) {
    console.error(result.error ?? "focus failed");
    process.exitCode = 1;
  }
}

async function cmdConfig(args: string[]): Promise<void> {
  const [sub, key, value] = args;
  if (!sub || sub === "show" || sub === "get") {
    const cfg = loadConfig();
    console.log(`${CONFIG_PATH}`);
    console.log(JSON.stringify(cfg, null, 2));
    console.log(`# ttl ≈ ${formatTtl(Math.round(cfg.ttlHours * 3_600_000))}`);
    return;
  }
  if (sub === "set") {
    if (!key || value === undefined) {
      console.error(
        "usage: watchty config set <autoOpen|background|focus|ttl> <value>",
      );
      process.exitCode = 1;
      return;
    }
    const patch: WatchtyConfig = {};
    if (key === "ttl" || key === "ttlHours" || key === "ttl-hours" || key === "ttl_hours") {
      const ms = parseTtl(value);
      if (ms === undefined) {
        console.error(`expected duration like 7d, 24h, 90m, or 0 (off); got: ${value}`);
        process.exitCode = 1;
        return;
      }
      patch.ttlHours = ms / 3_600_000;
    } else {
      const bool = parseBool(value);
      if (bool === undefined) {
        console.error(`expected true|false, got: ${value}`);
        process.exitCode = 1;
        return;
      }
      if (key === "autoOpen" || key === "auto-open" || key === "auto_open") {
        patch.autoOpen = bool;
      } else if (key === "background") {
        patch.background = bool;
      } else if (key === "focus") {
        patch.focus = bool;
      } else {
        console.error(`unknown key: ${key} (autoOpen | background | focus | ttl)`);
        process.exitCode = 1;
        return;
      }
    }
    const next = saveConfig(patch);
    console.log(`Wrote ${CONFIG_PATH}`);
    console.log(JSON.stringify(next, null, 2));
    return;
  }
  console.error("usage: watchty config [show|set <key> <value>]");
  process.exitCode = 1;
}

async function cmdCleanup(argv: string[]): Promise<void> {
  let ttlMs: number | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run" || a === "-n") {
      dryRun = true;
      continue;
    }
    if (a === "--ttl" || a === "-t") {
      const v = argv[++i];
      if (!v) {
        console.error("usage: watchty cleanup --ttl <7d|24h|…>");
        process.exitCode = 1;
        return;
      }
      const ms = parseTtl(v);
      if (ms === undefined) {
        console.error(`invalid ttl: ${v}`);
        process.exitCode = 1;
        return;
      }
      ttlMs = ms;
      continue;
    }
    if (a.startsWith("--ttl=")) {
      const ms = parseTtl(a.slice(6));
      if (ms === undefined) {
        console.error(`invalid ttl: ${a}`);
        process.exitCode = 1;
        return;
      }
      ttlMs = ms;
      continue;
    }
    console.error(`unknown flag: ${a}`);
    console.error("usage: watchty cleanup [--ttl <dur>] [--dry-run]");
    process.exitCode = 1;
    return;
  }

  if (ttlMs === undefined) {
    const cfg = loadConfig();
    ttlMs = Math.round(cfg.ttlHours * 3_600_000);
  }

  if (ttlMs <= 0) {
    console.error(
      "TTL is off (0). Pass --ttl <dur> or: watchty config set ttl 7d",
    );
    process.exitCode = 1;
    return;
  }

  const result = cleanupSessions({ ttlMs, dryRun });
  console.log(describeCleanup(result));
}

async function cmdInstallHooks(force = false): Promise<void> {
  const hooksPath = join(homedir(), ".cursor", "hooks.json");
  mkdirSync(join(homedir(), ".cursor"), { recursive: true });

  if (existsSync(hooksPath) && !force) {
    const raw = readFileSync(hooksPath, "utf8");
    if (!raw.includes("watchty")) {
      console.error(
        `${hooksPath} already exists and is not ours.\n` +
          `Merge manually, or re-run: watchty install-hooks --force`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const json = buildHooksJson();
  writeFileSync(hooksPath, JSON.stringify(json, null, 2) + "\n", "utf8");
  console.log(`Wrote ${hooksPath}`);
  console.log(`command: ${hooksCommand()}`);
}

async function cmdDoctor(): Promise<void> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  const bunPath = Bun.which("bun");
  checks.push({
    name: "bun",
    ok: Boolean(bunPath),
    detail: bunPath ?? "bun not on PATH",
  });

  const bin = selfBin();
  checks.push({
    name: "cli",
    ok: true,
    detail: bin,
  });

  const linked = Bun.which("watchty");
  checks.push({
    name: "PATH binary",
    ok: Boolean(linked),
    detail: linked
      ? linked
      : `not linked — run: cd ${packageRoot()} && bun link`,
  });

  const g = ghosttyAvailable();
  checks.push({ name: "Ghostty AppleScript", ok: g.ok, detail: g.detail });

  const hooksPath = join(homedir(), ".cursor", "hooks.json");
  let hooksOk = false;
  let hooksDetail = `${hooksPath} missing — run: watchty install-hooks`;
  if (existsSync(hooksPath)) {
    try {
      const raw = readFileSync(hooksPath, "utf8");
      hooksOk = raw.includes("watchty");
      hooksDetail = hooksOk
        ? `wired in ${hooksPath}`
        : `${hooksPath} exists but does not mention watchty — run install-hooks --force or merge`;
    } catch (e) {
      hooksDetail = String(e);
    }
  }
  checks.push({ name: "hooks.json", ok: hooksOk, detail: hooksDetail });

  const cfg = loadConfig();
  checks.push({
    name: "config",
    ok: true,
    detail: `${CONFIG_PATH} autoOpen=${cfg.autoOpen} background=${cfg.background} focus=${cfg.focus} ttl=${formatTtl(Math.round(cfg.ttlHours * 3_600_000))}`,
  });

  checks.push({
    name: "data dir",
    ok: true,
    detail: `${ROOT} (state: ${STATE_PATH}, logs: ${SESSIONS_DIR})`,
  });

  let failed = false;
  for (const c of checks) {
    const mark = c.ok ? "ok" : "!!";
    console.log(`[${mark}] ${c.name}: ${c.detail}`);
    if (!c.ok) failed = true;
  }

  if (!g.ok) {
    console.log(
      "\nHint: System Settings → Privacy & Security → Automation — allow the app running hooks (Cursor) to control Ghostty.",
    );
  }
  if (!linked) {
    console.log(`\nInstall: cd ${packageRoot()} && bun link`);
  }

  console.log(`\nExample: watchty view "Fix login"`);
  if (failed) process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [cmd, arg, flag] = argv;

  switch (cmd) {
    case "hook": {
      const payload = await readHookPayload();
      await handleHook(payload);
      break;
    }
    case "view": {
      await cmdView(arg);
      break;
    }
    case "list":
      await cmdList();
      break;
    case "focus": {
      if (!arg) {
        console.error("usage: watchty focus <title|id>");
        process.exitCode = 1;
        break;
      }
      await cmdFocus(arg);
      break;
    }
    case "config":
      await cmdConfig(argv.slice(1));
      break;
    case "cleanup":
      await cmdCleanup(argv.slice(1));
      break;
    case "install-hooks":
      await cmdInstallHooks(arg === "--force" || flag === "--force");
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

await main();
