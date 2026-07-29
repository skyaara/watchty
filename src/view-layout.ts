/**
 * Pure layout helpers for the session viewer TUI.
 * Kept separate from the interactive loop so they can be unit-tested.
 */
import { cleanCommand } from "./command-display";
import type { CommandRow } from "./store";

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const ITALIC = "\x1b[3m";
export const GREEN = "\x1b[32m";
export const RED = "\x1b[31m";
export const YELLOW = "\x1b[33m";

/** Sticky user-prompt rows at top of right pane (wraps, last truncates). */
export const PROMPT_HEADER_MAX_ROWS = 2;

/**
 * 2x2 = 4 braille dots (dots 1,4,2,5):
 *   1 4
 *   2 5
 */
const DOTS_2X2_FRAMES = [
  "⠁",
  "⠈",
  "⠐",
  "⠂",
  "⠉",
  "⠘",
  "⠒",
  "⠓",
  "⠛",
  "⠒",
  "⠉",
  "⠂",
] as const;

/** 3x3 braille-style dots — patterns as 9 chars of 0/1, row-major. */
const DOTS_3X3_FRAMES = [
  "100000000",
  "010000000",
  "001000000",
  "000010000",
  "000001000",
  "000000001",
  "000000010",
  "000000100",
  "000100000",
  "010000000",
  "111000000",
  "111111000",
  "111111111",
  "011111111",
  "000111111",
  "000000111",
  "000000000",
] as const;

function dots2x2Frame(): string {
  return DOTS_2X2_FRAMES[Math.floor(Date.now() / 100) % DOTS_2X2_FRAMES.length]!;
}

/**
 * Pack a 3x3 boolean grid into 3 braille chars on one line.
 * Each char is one column (dots 1/2/3 = top/mid/bot).
 */
function dots3x3Inline(): string {
  const raw =
    DOTS_3X3_FRAMES[Math.floor(Date.now() / 110) % DOTS_3X3_FRAMES.length]!;
  const col = (c: number) => {
    let bits = 0;
    if (raw[c] === "1") bits |= 0x01;
    if (raw[3 + c] === "1") bits |= 0x02;
    if (raw[6 + c] === "1") bits |= 0x04;
    return String.fromCharCode(0x2800 + bits);
  };
  return `${YELLOW}${col(0)}${col(1)}${col(2)}${RESET}`;
}

/** Sidebar: green • if ok, ! if failed, 4-dot braille if running. */
export function statusGlyph(cmd: CommandRow, selected: boolean): string {
  const end = selected ? "" : RESET;
  if (cmd.running) {
    return `${YELLOW}${dots2x2Frame()}${end}`;
  }
  const ok = cmd.exitCode === 0 || cmd.exitCode == null;
  if (ok) return `${GREEN}•${end}`;
  return `${RED}!${end}`;
}

export function runningBannerLine(): string {
  return `${dots3x3Inline()} ${DIM}running${RESET}`;
}

/** True when curr starts a new agent prompt relative to prev. */
export function isNewPrompt(prev: CommandRow, curr: CommandRow): boolean {
  if (prev.generationId && curr.generationId) {
    return prev.generationId !== curr.generationId;
  }
  const ta = Date.parse(prev.startedAt);
  const tb = Date.parse(curr.startedAt);
  if (Number.isFinite(ta) && Number.isFinite(tb)) {
    return tb - ta >= 90_000;
  }
  return false;
}

export type SidebarItem =
  | { kind: "prompt" }
  | { kind: "rule" }
  | { kind: "cmd"; index: number };

export function buildSidebarItems(
  cmds: CommandRow[],
  promptsByGen: Map<string, string>,
): SidebarItem[] {
  const items: SidebarItem[] = [];
  for (let i = 0; i < cmds.length; i++) {
    const gen = cmds[i]?.generationId;
    const hasPrompt = Boolean(gen && promptsByGen.get(gen));
    if (i === 0) {
      if (hasPrompt) items.push({ kind: "prompt" });
    } else if (isNewPrompt(cmds[i - 1]!, cmds[i]!)) {
      items.push({ kind: "rule" });
      if (hasPrompt) items.push({ kind: "prompt" });
    }
    items.push({ kind: "cmd", index: i });
  }
  return items;
}

/** Short label for sidebar from cleaned command (no truncation — caller clips). */
export function sidebarLabelText(command: string): string {
  const { label } = cleanCommand(command);
  const flat = label.replace(/\s+/g, " ").trim();
  if (!flat) return "(cmd)";
  const first = flat.split(" ")[0] ?? flat;
  const base = first.includes("/") ? (first.split("/").pop() ?? first) : first;
  const rest = flat.slice(first.length).trim();
  return rest ? `${base} ${rest}` : base;
}

/** Fit plain text into `n` columns, trailing with `...` when clipped. */
export function truncatePlain(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  if (n <= 3) return ".".repeat(n);
  return s.slice(0, n - 3) + "...";
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Expand tabs to spaces so column math matches terminal rendering (tab stops = 8). */
export function expandTabs(text: string, tabSize = 8): string {
  let out = "";
  let col = 0;
  for (const ch of text) {
    if (ch === "\t") {
      const n = tabSize - (col % tabSize);
      out += " ".repeat(n);
      col += n;
    } else {
      out += ch;
      col += 1;
    }
  }
  return out;
}

export function visibleLen(s: string): number {
  return stripAnsi(s).length;
}

/** Clip a possibly-styled string to exactly n visible columns. */
export function clipVisible(s: string, n: number): string {
  const plain = stripAnsi(s);
  if (plain.length <= n) return s + " ".repeat(n - plain.length);
  return truncatePlain(plain, n);
}

export function homeify(p?: string): string {
  if (!p) return "";
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

/** Wrap/truncate user prompt into sticky header lines for the right pane. */
export function buildPromptHeader(
  text: string | undefined,
  width: number,
  maxRows = PROMPT_HEADER_MAX_ROWS,
): string[] {
  if (!text?.trim() || width < 8 || maxRows < 1) return [];
  const flat = text.replace(/\s+/g, " ").trim();
  const prefix = "› ";
  const wrapW = Math.max(4, width - prefix.length);
  const chunks: string[] = [];
  let remaining = flat;
  while (remaining.length > 0 && chunks.length < maxRows) {
    const last = chunks.length === maxRows - 1;
    if (last && remaining.length > wrapW) {
      chunks.push(truncatePlain(remaining, wrapW));
      break;
    }
    chunks.push(remaining.slice(0, wrapW));
    remaining = remaining.slice(wrapW);
  }
  return chunks.map((c, i) => {
    const p = i === 0 ? prefix : "  ";
    return `${ITALIC}${p}${c}${RESET}`;
  });
}

export function buildPanelLines(
  cmd: CommandRow | undefined,
  width: number,
): string[] {
  if (!cmd) {
    return [`${DIM}  select a command from the sidebar${RESET}`];
  }

  const cwd = homeify(cmd.cwd) || ".";
  const cleaned = cleanCommand(cmd.command);
  const lines: string[] = [];

  const promptMark = cmd.running
    ? `${YELLOW}%${RESET}`
    : cmd.exitCode && cmd.exitCode !== 0
      ? `${RED}%${RESET}`
      : `${GREEN}%${RESET}`;

  const promptPrefix = `${DIM}${cwd}${RESET} ${promptMark} `;
  const cmdLines = cleaned.display.split("\n");
  for (let li = 0; li < cmdLines.length; li++) {
    const line = expandTabs(cmdLines[li]!);
    const prefix = li === 0 ? promptPrefix : "  ";
    const wrapW = Math.max(8, width - visibleLen(prefix) - 1);
    let remaining = line;
    let firstChunk = true;
    while (remaining.length > 0 || firstChunk) {
      const chunk = remaining.slice(0, wrapW);
      remaining = remaining.slice(wrapW);
      lines.push(`${firstChunk ? prefix : "  "}${BOLD}${chunk}${RESET}`);
      firstChunk = false;
      if (!remaining) break;
    }
  }

  if (cleaned.display !== cleaned.raw && cleaned.raw.includes("export PATH")) {
    lines.push(`${DIM}(env preamble hidden)${RESET}`);
  }

  lines.push("");

  if (cmd.running && !cmd.output) {
    lines.push(runningBannerLine());
  } else if (!cmd.output) {
    lines.push(`${DIM}(no output)${RESET}`);
  } else {
    for (const line of cmd.output.replace(/\n$/, "").split("\n")) {
      const expanded = expandTabs(line);
      if (expanded.includes("\x1b[")) {
        lines.push(expanded);
      } else {
        lines.push(`${DIM}${expanded}${RESET}`);
      }
    }
    if (cmd.running) {
      lines.push(runningBannerLine());
    }
  }

  lines.push("");
  if (!cmd.running) {
    const code = cmd.exitCode;
    const ok = code === 0 || code == null;
    if (!ok) {
      const status = `exit ${code}`;
      const dur =
        cmd.durationMs != null ? `${DIM} · ${cmd.durationMs}ms${RESET}` : "";
      lines.push(`${RED}${BOLD}! ${status}${RESET}${dur}`);
    } else if (cmd.durationMs != null) {
      lines.push(`${DIM}exit 0 · ${cmd.durationMs}ms${RESET}`);
    } else {
      lines.push(`${DIM}exit 0${RESET}`);
    }
  }

  return lines;
}

/** Truncate a string that may contain ANSI, by visible width. */
export function truncateStyled(s: string, n: number): string {
  if (visibleLen(s) <= n) return s;
  let out = "";
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b") {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (w >= n - 3) {
      out += "..." + RESET;
      break;
    }
    out += s[i];
    w++;
  }
  return out;
}
