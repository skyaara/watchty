import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { selfBin } from "./hook";

export function hooksCommand(): string {
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

export function buildHooksJson(): HooksFile {
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

export async function cmdInstallHooks(force = false): Promise<void> {
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
