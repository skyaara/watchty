import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolvedSettings, type HooksScope } from "./config";
import { selfBin, shellQuote } from "./hook";
import { detectCursorWorkspace } from "./workspace";

/** ~/.cursor, or WATCHTY_CURSOR_DIR for tests / alternate installs. */
export function globalCursorDir(): string {
  return process.env.WATCHTY_CURSOR_DIR?.trim() || join(homedir(), ".cursor");
}

function hooksCommand(): string {
  const linked = Bun.which("watchty");
  if (linked) return `${shellQuote(linked)} hook`;
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
  const shellEntry = [{ command, matcher: "Shell" }];
  return {
    version: 1,
    hooks: {
      sessionStart: entry,
      beforeSubmitPrompt: entry,
      preToolUse: shellEntry,
      postToolUse: shellEntry,
      postToolUseFailure: shellEntry,
      sessionEnd: entry,
    },
  };
}

function isWatchtyHookEntry(entry: unknown): boolean {
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("command" in entry) ||
    typeof (entry as HookEntry).command !== "string"
  ) {
    return false;
  }
  return (entry as HookEntry).command.includes("watchty");
}

/** Insert/update watchty hook entries without dropping unrelated hooks. */
export function mergeWatchtyHooks(existing: HooksFile, ours: HooksFile): HooksFile {
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

/**
 * Directory that should contain hooks.json for the given scope.
 * Workspace scope needs a Cursor project root; returns undefined if none.
 */
export function resolveHooksDir(
  scope: HooksScope,
  cwd = process.cwd(),
): string | undefined {
  if (scope === "global") return globalCursorDir();
  const root = detectCursorWorkspace(cwd);
  if (!root) return undefined;
  return join(root, ".cursor");
}

export function resolveHooksPath(
  scope: HooksScope,
  cwd = process.cwd(),
): string | undefined {
  const dir = resolveHooksDir(scope, cwd);
  return dir ? join(dir, "hooks.json") : undefined;
}

/** Config/env default (used by doctor and non-interactive install). */
export function effectiveHooksScope(override?: HooksScope): HooksScope {
  return override ?? resolvedSettings().hooksScope;
}

export function parseInstallHooksArgs(argv: string[]): {
  scope?: HooksScope;
  error?: string;
} {
  let scope: HooksScope | undefined;
  for (const a of argv) {
    if (a === "--global" || a === "-g") {
      if (scope === "workspace") {
        return { error: "use either --global or --workspace, not both" };
      }
      scope = "global";
      continue;
    }
    if (a === "--workspace" || a === "-w" || a === "--local") {
      if (scope === "global") {
        return { error: "use either --global or --workspace, not both" };
      }
      scope = "workspace";
      continue;
    }
    return { error: `unknown flag: ${a}` };
  }
  return { scope };
}

/** Interactive pick when no --global/--workspace flag was passed. */
export async function promptHooksScope(
  cwd = process.cwd(),
): Promise<HooksScope | undefined> {
  const workspaceRoot = detectCursorWorkspace(cwd);
  const globalPath = join(globalCursorDir(), "hooks.json");
  const preferred = resolvedSettings().hooksScope;
  const defaultChoice =
    preferred === "workspace" && workspaceRoot ? "2" : "1";

  console.log("Install Cursor hooks where?");
  console.log(`  1) global     ${globalPath}`);
  if (workspaceRoot) {
    console.log(
      `  2) workspace  ${join(workspaceRoot, ".cursor", "hooks.json")}`,
    );
  } else {
    console.log(
      "  2) workspace  (unavailable — cwd is not a Cursor project)",
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (
      await rl.question(`Choice [${defaultChoice}]: `)
    ).trim();
    const choice = answer || defaultChoice;
    if (choice === "1" || choice === "g" || choice === "global") {
      return "global";
    }
    if (choice === "2" || choice === "w" || choice === "workspace") {
      if (!workspaceRoot) {
        console.error(
          "Workspace install needs a Cursor project. Pick 1, or: watchty install-hooks --global",
        );
        return undefined;
      }
      return "workspace";
    }
    console.error("Expected 1 (global) or 2 (workspace).");
    return undefined;
  } finally {
    rl.close();
  }
}

async function resolveInstallScope(
  scopeOverride?: HooksScope,
): Promise<HooksScope | undefined> {
  if (scopeOverride) return scopeOverride;

  // Non-interactive (CI / piped): use config default.
  if (!input.isTTY || !output.isTTY) {
    return effectiveHooksScope();
  }

  return promptHooksScope();
}

export async function cmdInstallHooks(scopeOverride?: HooksScope): Promise<void> {
  const scope = await resolveInstallScope(scopeOverride);
  if (!scope) {
    process.exitCode = 1;
    return;
  }

  const dir = resolveHooksDir(scope);
  if (!dir) {
    console.error(
      "Not inside a Cursor workspace.\n" +
        "cd into a project (with .cursor/ or a prior watchty session), or run:\n" +
        "  watchty install-hooks --global",
    );
    process.exitCode = 1;
    return;
  }

  const hooksPath = join(dir, "hooks.json");
  mkdirSync(dir, { recursive: true });
  const ours = buildHooksJson();

  if (!existsSync(hooksPath)) {
    writeFileSync(hooksPath, JSON.stringify(ours, null, 2) + "\n", "utf8");
    console.log(`Wrote ${hooksPath} (${scope})`);
    console.log(`command: ${hooksCommand()}`);
    return;
  }

  const raw = readFileSync(hooksPath, "utf8");
  let existing: HooksFile;
  try {
    existing = JSON.parse(raw) as HooksFile;
  } catch {
    console.error(
      `${hooksPath} is not valid JSON.\n` +
        `Fix the file, then re-run: watchty install-hooks`,
    );
    process.exitCode = 1;
    return;
  }

  // Always merge: replace watchty entries, keep unrelated hooks.
  const next = mergeWatchtyHooks(existing, ours);
  writeFileSync(hooksPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(`Merged watchty hooks into ${hooksPath} (${scope})`);
  console.log(`command: ${hooksCommand()}`);
}
