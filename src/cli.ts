#!/usr/bin/env bun
import { CONFIG_PATH, loadConfig, parseHooksScope, saveConfig, type WatchtyConfig } from "./config";
import {
  cleanupSessions,
  describeCleanup,
  formatTtl,
  parseTtl,
} from "./cleanup";
import { focusSessionTab } from "./ghostty";
import { handleHook, readHookPayload } from "./hook";
import { cmdInstallHooks, parseInstallHooksArgs } from "./hooks";
import { cmdDoctor } from "./doctor";
import { workspaceWindowTitle } from "./paths";
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
  watchty install-hooks [--global|--workspace]  Write hooks.json (prompt if no flag)
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
  hooksScope   global|workspace  Default pick for install-hooks prompt (default global)

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

/** Chat titles may be typed/completed unquoted; shell splits on spaces. */
function joinQuery(positionals: string[]): string | undefined {
  const q = positionals.join(" ").trim();
  return q || undefined;
}

function getSessionByPrefix(prefix: string, scope: Scope = { workspace: null }) {
  // Exact conversation id always wins. Hooks auto-open with full UUIDs, and
  // sessionStart often arrives before workspace_roots — those sessions have no
  // workspace yet, so scoped filtering would wrongly reject them.
  const exact = getSession(prefix);
  if (exact) return exact;

  // Unique id prefix across all sessions (not workspace-scoped) — same reason.
  const allIdMatches = listSessions().filter((s) => s.id.startsWith(prefix));
  if (allIdMatches.length === 1) return allIdMatches[0];
  if (allIdMatches.length > 1) return undefined;

  const sessions = scopedSessions(scope);
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

/** Most recently updated session in scope (endedAt is a soft label, not a filter). */
function latestSession(scope: Scope = { workspace: undefined }) {
  return scopedSessions(scope)[0];
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
        "usage: watchty config set <autoOpen|background|focus|ttl|hooksScope> <value>",
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
    } else if (
      key === "hooksScope" ||
      key === "hooks-scope" ||
      key === "hooks_scope" ||
      key === "hookScope"
    ) {
      const scope = parseHooksScope(value);
      if (!scope) {
        console.error(`expected global|workspace; got: ${value}`);
        process.exitCode = 1;
        return;
      }
      patch.hooksScope = scope;
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
        console.error(
          `unknown key: ${key} (autoOpen | background | focus | ttl | hooksScope)`,
        );
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
      // Join positionals so unquoted multi-word titles work natively:
      //   watchty view Explore pane/prompt UI
      await cmdView(parsed.scope, joinQuery(parsed.positionals));
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
      const query = joinQuery(parsed.positionals);
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
    case "install-hooks": {
      const parsed = parseInstallHooksArgs(rest);
      if (parsed.error) {
        console.error(parsed.error);
        console.error(
          "usage: watchty install-hooks [--global|--workspace]",
        );
        process.exitCode = 1;
        break;
      }
      await cmdInstallHooks(parsed.scope);
      break;
    }
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
