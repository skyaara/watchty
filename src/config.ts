import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ROOT } from "./paths";
import { join } from "node:path";
import { parseTtl } from "./ttl";

export const CONFIG_PATH = join(ROOT, "config.json");

export type WatchtyConfig = {
  /** Open Ghostty tabs from hooks (default true). */
  autoOpen?: boolean;
  /** Open without activate — keep current app focused (default true). */
  background?: boolean;
  /** Focus/select session tab when opening or on new commands (default false). */
  focus?: boolean;
  /**
   * Auto-delete session transcripts older than this many hours (default 168 = 7d).
   * Set to 0 to disable automatic cleanup (manual `cleanup --ttl …` still works).
   */
  ttlHours?: number;
};

const DEFAULTS: Required<WatchtyConfig> = {
  autoOpen: true,
  background: true,
  focus: false,
  ttlHours: 168,
};

export function loadConfig(): Required<WatchtyConfig> {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as WatchtyConfig;
    return {
      autoOpen: raw.autoOpen ?? DEFAULTS.autoOpen,
      background: raw.background ?? DEFAULTS.background,
      focus: raw.focus ?? DEFAULTS.focus,
      ttlHours:
        typeof raw.ttlHours === "number" && Number.isFinite(raw.ttlHours)
          ? Math.max(0, raw.ttlHours)
          : DEFAULTS.ttlHours,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(patch: WatchtyConfig): Required<WatchtyConfig> {
  mkdirSync(ROOT, { recursive: true });
  const next = { ...loadConfig(), ...patch };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return undefined;
}

function envTtlHours(): number | undefined {
  const raw = process.env.WATCHTY_TTL ?? process.env.WATCHTY_TTL_HOURS;
  if (raw === undefined) return undefined;
  const ms = parseTtl(raw);
  if (ms === undefined) return undefined;
  return ms / 3_600_000;
}

/** Env overrides config file (so one-off exports still work). */
export function resolvedSettings(): Required<WatchtyConfig> {
  const cfg = loadConfig();
  return {
    autoOpen: envBool("WATCHTY_AUTO_OPEN") ?? cfg.autoOpen,
    background: envBool("WATCHTY_BACKGROUND") ?? cfg.background,
    focus: envBool("WATCHTY_FOCUS") ?? cfg.focus,
    ttlHours: envTtlHours() ?? cfg.ttlHours,
  };
}
