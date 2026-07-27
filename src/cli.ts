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
import { ROOT, STATE_PATH, SESSIONS_DIR, workspaceWindowTitle, workspaceMatches } from "./paths";
import { getSession, listSessions, type SessionRecord } from "./store";
import { viewSession } from "./view";
import { printComplete, handleCompletionCommand } from "./completion";
import { detectCursorWorkspace } from "./workspace";

const HELP = `watchty — watch Cursor Agent shell commands in Ghostty tabs

Usage:
  watchty hook              Read Cursor hook JSON from stdin
  watchty view [title|id]   Follow a session (omit = latest live)
  watchty list              List sessions (current Cursor workspace by default)
  watchty focus <title|id>  Focus the Ghostty tab for a session
  watchty cleanup [--ttl <dur>] [--dry-run]
  watchty config            Show ~/.cursor/watchty/config.json
  watchty config set <k> <v>
  watchty install-hooks     Write ~/.cursor/hooks.json with absolute binary path
  watchty doctor            Check install / Ghostty / hooks
  watchty completion install   Enable tab-complete for session names
  watchty help

Workspace filter (list / view / focus / tab-complete):
  (default)   Current folder if it’s a Cursor workspace; otherwise all
  -w, --workspace <name|path|.>   Limit to that workspace
  -a, --all                       All workspaces

  watchty list
  watchty list -w my-app
  watchty list --all
  watchty view -w . "Fix login"

Tab-complete: watchty view <Tab> / watchty focus <Tab>
  watchty completion install

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

type Scope = {
  /** undefined = auto (Cursor workspace or all); null = --all; string = explicit -w */
  workspace: string | null | undefined;
};

function workspaceOpt(scope: Scope): string | undefined {
  if (scope.workspace === null) return undefined; // --all
  if (scope.workspace !== undefined) return scope.workspace; // explicit -w
  return detectCursorWorkspace(process.cwd()); // auto: only if Cursor workspace
}

function scopedSessions(scope: Scope): SessionRecord[] {
  return listSessions({ workspace: workspaceOpt(scope) });
}

function parseScopeAndArgs(argv: string[]): {
  scope: Scope;
  positionals: string[];
  error?: string;
} {
  const scope: Scope = { workspace: undefined };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--all" || a === "-a") {
      scope.workspace = null;
      continue;
    }
    if (a === "--workspace" || a === "-w") {
      const v = argv[++i];
      if (!v) return { scope, positionals, error: "missing value for --workspace" };
      scope.workspace = v;
      continue;
    }
    if (a.startsWith("--workspace=")) {
      scope.workspace = a.slice("--workspace=".length);
      continue;
    }
    if (a.startsWith("-w=")) {
      scope.workspace = a.slice(3);
      continue;
    }
    if (a.startsWith("-")) {
      return { scope, positionals, error: `unknown flag: ${a}` };
    }
    positionals.push(a);
  }
  return { scope, positionals };
}

function describeScope(scope: Scope): string {
  if (scope.workspace === null) return "all workspaces";
  const w = workspaceOpt(scope);
  if (!w) return "all workspaces (cwd is not a Cursor workspace)";
  return workspaceWindowTitle(w) + ` (${w})`;
}

function hooksCommand(): string {
  const linked = Bun.which("watchty");
  if (linked) return `${linked} hook`;
  return `${selfBin()} hook`;
}

type HookEntry = { command: string; [key: string]: unknown };
type HooksFile = {
  version?: number;
  hooks?: Record<string, HookEntry[] | unknown>;
  [key: string]: unknown;
};

function buildHooksJson(): HooksFile {
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

function isWatchtyHookEntry(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "command" in entry &&
    typeof (entry as HookEntry).command === "string" &&
    (entry as HookEntry).command.includes("watchty")
  );
}

/** Insert/update watchty hook entries without dropping unrelated hooks. */
function mergeWatchtyHooks(existing: HooksFile, ours: HooksFile): HooksFile {
  const hooks: Record<string, unknown> = { ...(existing.hooks ?? {}) };
  for (const [event, entries] of Object.entries(ours.hooks ?? {})) {
    const current = Array.isArray(hooks[event])
      ? ([...(hooks[event] as HookEntry[])] as HookEntry[])
      : [];
    const kept = current.filter((e) => !isWatchtyHookEntry(e));
    const oursEntries = Array.isArray(entries) ? (entries as HookEntry[]) : [];
    hooks[event] = [...kept, ...oursEntries];
  }
  return {
    ...existing,
    version: existing.version ?? ours.version ?? 1,
    hooks,
  };
}

function getSessionByPrefix(prefix: string, scope: Scope = { workspace: null }) {
  const sessions = scopedSessions(scope);
  const exact = getSession(prefix);
  if (exact) {
    const w = workspaceOpt(scope);
    if (!w) return exact; // --all or no Cursor workspace detected
    if (workspaceMatches(exact.workspace, w)) return exact;
    return undefined;
  }
  const idMatches = sessions.filter((s) => s.id.startsWith(prefix));
  if (idMatches.length === 1) return idMatches[0];

  const q = prefix.trim().toLowerCase();
  if (!q) return undefined;
  const titleMatchesList = sessions.filter((s) => {
    const t = s.title.toLowerCase();
    const name = t.includes(" | ") ? t.slice(t.lastIndexOf(" | ") + 3) : t;
    return t.includes(q) || name.includes(q);
  });
  return titleMatchesList.length === 1 ? titleMatchesList[0] : undefined;
}

function titleMatches(query: string, scope: Scope = { workspace: null }) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return scopedSessions(scope).filter((s) => {
    const t = s.title.toLowerCase();
    const name = t.includes(" | ") ? t.slice(t.lastIndexOf(" | ") + 3) : t;
    return t.includes(q) || name.includes(q);
  });
}

/** Most recently updated session that has not ended (or any latest if none live). */
function latestSession(scope: Scope = { workspace: undefined }) {
  const sessions = scopedSessions(scope);
  const live = sessions.find((s) => !s.endedAt);
  return live ?? sessions[0];
}

function parseBool(v: string): boolean | undefined {
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

async function cmdList(scope: Scope): Promise<void> {
  const sessions = scopedSessions(scope);
  if (!sessions.length) {
    const all = listSessions();
    if (!all.length) {
      console.log("No sessions yet. Run an Agent chat with hooks installed.");
      return;
    }
    console.log(`No sessions for ${describeScope(scope)}.`);
    console.log(`Try: watchty list --all`);
    return;
  }
  console.log(`# ${describeScope(scope)} · ${sessions.length} session(s)`);
  for (const s of sessions) {
    const ended = s.endedAt ? "ended" : "live ";
    const name = s.title.includes(" | ")
      ? s.title.slice(s.title.lastIndexOf(" | ") + 3)
      : s.title;
    const ws = s.workspace ? workspaceWindowTitle(s.workspace) : "?";
    console.log(`${ended}  ${name}`);
    console.log(`        ${s.title}  ·  ${ws}  ·  ${s.id.slice(0, 8)}`);
  }
  console.log(`\nAttach: watchty view -w . \"<title substring>\"`);
}

async function cmdView(scope: Scope, idArg?: string): Promise<void> {
  if (idArg) {
    const session = getSessionByPrefix(idArg, scope);
    if (!session) {
      const matches = titleMatches(idArg, scope);
      if (matches.length > 1) {
        console.error(`Multiple sessions match "${idArg}":`);
        for (const s of matches) {
          console.error(`  ${s.id.slice(0, 8)}  ${s.title}`);
        }
        process.exitCode = 1;
        return;
      }
      console.error(
        `No session matching "${idArg}" in ${describeScope(scope)}. Try: watchty list --all`,
      );
      process.exitCode = 1;
      return;
    }
    console.error(`viewing ${session.title}`);
    await viewSession(session.id);
    return;
  }
  const latest = latestSession(scope);
  if (!latest) {
    console.error(
      `No sessions for ${describeScope(scope)}. Try:\n` +
        `  watchty list --all\n` +
        `  watchty view --all \"<agent title>\"`,
    );
    process.exitCode = 1;
    return;
  }
  console.error(`viewing ${latest.title}`);
  await viewSession(latest.id);
}

async function cmdFocus(scope: Scope, query: string): Promise<void> {
  const session = getSessionByPrefix(query, scope);
  if (!session) {
    const matches = titleMatches(query, scope);
    if (matches.length > 1) {
      console.error(`Multiple sessions match "${query}":`);
      for (const s of matches) {
        console.error(`  ${s.id.slice(0, 8)}  ${s.title}`);
      }
      process.exitCode = 1;
      return;
    }
    console.error(`Unknown session: ${query} (${describeScope(scope)})`);
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
  const ours = buildHooksJson();

  if (!existsSync(hooksPath)) {
    writeFileSync(hooksPath, JSON.stringify(ours, null, 2) + "\n", "utf8");
    console.log(`Wrote ${hooksPath}`);
    console.log(`command: ${hooksCommand()}`);
    return;
  }

  const raw = readFileSync(hooksPath, "utf8");
  let existing: HooksFile;
  try {
    existing = JSON.parse(raw) as HooksFile;
  } catch {
    if (!force) {
      console.error(
        `${hooksPath} is not valid JSON.\n` +
          `Fix it, or re-run: watchty install-hooks --force`,
      );
      process.exitCode = 1;
      return;
    }
    writeFileSync(hooksPath, JSON.stringify(ours, null, 2) + "\n", "utf8");
    console.log(`Wrote ${hooksPath} (--force, replaced invalid JSON)`);
    console.log(`command: ${hooksCommand()}`);
    return;
  }

  if (!raw.includes("watchty") && !force) {
    console.error(
      `${hooksPath} already exists and is not ours.\n` +
        `Merge manually, or re-run: watchty install-hooks --force\n` +
        `(--force merges watchty in; other hooks are preserved)`,
    );
    process.exitCode = 1;
    return;
  }

  const merged = mergeWatchtyHooks(existing, ours);
  writeFileSync(hooksPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  console.log(`Updated watchty hooks in ${hooksPath} (other hooks preserved)`);
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
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case "hook": {
      const payload = await readHookPayload();
      await handleHook(payload);
      break;
    }
    case "view": {
      const parsed = parseScopeAndArgs(rest);
      if (parsed.error) {
        console.error(parsed.error);
        console.error("usage: watchty view [-w <workspace>|--all] [title|id]");
        process.exitCode = 1;
        break;
      }
      await cmdView(parsed.scope, parsed.positionals[0]);
      break;
    }
    case "list": {
      const parsed = parseScopeAndArgs(rest);
      if (parsed.error) {
        console.error(parsed.error);
        console.error("usage: watchty list [-w <workspace>|--all]");
        process.exitCode = 1;
        break;
      }
      await cmdList(parsed.scope);
      break;
    }
    case "focus": {
      const parsed = parseScopeAndArgs(rest);
      if (parsed.error) {
        console.error(parsed.error);
        console.error("usage: watchty focus [-w <workspace>|--all] <title|id>");
        process.exitCode = 1;
        break;
      }
      const query = parsed.positionals[0];
      if (!query) {
        console.error("usage: watchty focus [-w <workspace>|--all] <title|id>");
        process.exitCode = 1;
        break;
      }
      await cmdFocus(parsed.scope, query);
      break;
    }
    case "config":
      await cmdConfig(rest);
      break;
    case "cleanup":
      await cmdCleanup(rest);
      break;
    case "install-hooks":
      await cmdInstallHooks(rest.includes("--force"));
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "completion":
      handleCompletionCommand(rest);
      break;
    case "complete":
      // Used by shell completion scripts: watchty complete sessions [prefix]
      printComplete(rest);
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
