/**
 * Cursor Agent often wraps shells as multi-line scripts starting with
 * `export PATH=...`, `cd ...`, etc. Normalize those for sidebar + panel display.
 */

const BOILERPLATE_LINE =
  /^\s*(?:export\s+[A-Za-z_][\w]*=.*|unset\s+.*|cd\s+(?:'[^']*'|"[^"]*"|[^\s;&#|]+)\s*(?:#.*)?|set\s+-[a-zA-Z]+.*|ulimit\s+.*|umask\s+.*|true|:)\s*;?\s*$/;

const BOILERPLATE_PREFIX =
  /^(?:export\s+[A-Za-z_][\w]*=(?:'[^']*'|"[^"]*"|\$\{[^}]+\}|[^\s;]+)\s*;\s*|cd\s+(?:'[^']*'|"[^"]*"|[^\s;]+)\s*;\s*|set\s+-[a-zA-Z]+\s*;\s*)+/;

export type CleanCommand = {
  /** Short one-line label for the sidebar */
  label: string;
  /** Cleaned multi-line body for the command pane (boilerplate stripped) */
  display: string;
  /** Original untouched */
  raw: string;
};

function isBoilerplateLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (BOILERPLATE_LINE.test(t)) return true;
  // PATH-only exports that span oddly
  if (/^export\s+PATH=/.test(t)) return true;
  if (/^export\s+BUN_INSTALL=/.test(t)) return true;
  return false;
}

function stripInlineBoilerplate(s: string): string {
  let out = s.trim();
  for (let i = 0; i < 8; i++) {
    const next = out.replace(BOILERPLATE_PREFIX, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

function meaningfulLines(raw: string): string[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  const kept = lines.filter((l) => !isBoilerplateLine(l));
  const base = kept.length > 0 ? kept : lines;

  return base.map((l) => stripInlineBoilerplate(l)).filter((l) => l.length > 0);
}

function pickLabel(lines: string[]): string {
  if (!lines.length) return "(command)";

  const skipTail =
    /^(fi|done|else|elif\b.*|esac|\}|;|then|EOF|END|['"`]+|\(|\)|end\s+(tell|try|repeat|if))$/i;

  const looksUseful = (line: string): boolean => {
    const t = line.trim();
    if (!t || skipTail.test(t)) return false;
    if (t.length < 2) return false;
    // Prefer lines that start like a command / path / env invocation
    if (
      /^(echo|printf|bun|npm|npx|pnpm|yarn|git|ls|curl|wget|osascript|python3?|node|deno|cargo|go|make|docker|kubectl|rg|fd|cat|head|tail|sed|awk|jq|watchty|which|true|false|sleep|mkdir|rm|cp|mv|chmod|ssh|scp)\b/i.test(
        t,
      )
    ) {
      return true;
    }
    if (/^[./~a-zA-Z0-9_-]+/.test(t) && t.length > 2) return true;
    return false;
  };

  let chosen: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (looksUseful(lines[i]!)) {
      chosen = lines[i]!;
      break;
    }
  }
  if (!chosen) {
    // fall back to first non-skip line
    chosen = lines.find((l) => !skipTail.test(l.trim())) ?? lines[0]!;
  }

  let label = chosen.replace(/\s+/g, " ").trim();

  label = label.replace(
    /^(bun|node|python3?|ruby|perl)\s+(-e|--eval|-c)\s+(['"])([\s\S]*)$/i,
    (_m, rt: string, flag: string, q: string, body: string) => {
      let inner = body;
      if (inner.endsWith(q)) inner = inner.slice(0, -1);
      const short = inner.length > 40 ? inner.slice(0, 37) + "…" : inner;
      return `${rt} ${flag} ${q}${short}${q}`;
    },
  );

  return truncate(label, 56);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

export function cleanCommand(raw: string): CleanCommand {
  const original = raw ?? "";
  const lines = meaningfulLines(original);
  const display = lines.length ? lines.join("\n") : stripInlineBoilerplate(original) || original;
  const label = pickLabel(display.split("\n").filter(Boolean));
  return { label, display: display || original, raw: original };
}
