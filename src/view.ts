import { setGhosttyTitles, ensureShellSplit, shellCd, focusShell } from "./ghostty";
import { shortId } from "./paths";
import { resolveSessionTitle, setTerminalTitle } from "./session-name";
import { cleanCommand } from "./command-display";
import {
  eventsToCommands,
  getSession,
  loadEvents,
  sessionEventsPath,
  upsertSession,
  type CommandRow,
} from "./store";
import { existsSync, statSync } from "node:fs";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const REVERSE = "\x1b[7m";
/** Theme-mapped ANSI (Ghostty remaps these; avoid 256/truecolor). */
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const CLEAR = "\x1b[2J\x1b[H";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

const SIDEBAR_MAX = 28;
const SIDEBAR_MIN = 18;

/**
 * 2x2 = 4 braille dots (dots 1,4,2,5):
 *   1 4
 *   2 5
 * Same pixel-dot feel as before, constrained to four dots.
 */
const DOTS_2X2_FRAMES = [
  "⠁", // TL (1)
  "⠈", // TR (4)
  "⠐", // BR (5)
  "⠂", // BL (2)
  "⠉", // top (1+4)
  "⠘", // right (4+5)
  "⠒", // bottom (2+5)
  "⠓", // left (1+2+5) — close enough; ⠋ is 1+2+3+5
  "⠛", // all four (1+2+4+5)
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
    if (raw[c] === "1") bits |= 0x01; // row0 → dot 1
    if (raw[3 + c] === "1") bits |= 0x02; // row1 → dot 2
    if (raw[6 + c] === "1") bits |= 0x04; // row2 → dot 3
    return String.fromCharCode(0x2800 + bits);
  };
  return `${YELLOW}${col(0)}${col(1)}${col(2)}${RESET}`;
}

/** Sidebar: green • if ok, ! if failed, 4-dot braille if running. */
function statusGlyph(cmd: CommandRow, selected: boolean): string {
  // When selected, omit RESET so reverse-video selection can wrap the whole row.
  const end = selected ? "" : RESET;
  if (cmd.running) {
    return `${YELLOW}${dots2x2Frame()}${end}`;
  }
  const ok = cmd.exitCode === 0 || cmd.exitCode == null;
  if (ok) return `${GREEN}•${end}`;
  return `${RED}!${end}`;
}

function runningBannerLine(): string {
  return `${dots3x3Inline()} ${DIM}running${RESET}`;
}

/** True when curr starts a new agent prompt relative to prev. */
function isNewPrompt(prev: CommandRow, curr: CommandRow): boolean {
  if (prev.generationId && curr.generationId) {
    return prev.generationId !== curr.generationId;
  }
  // Legacy events without generationId: split on ~90s idle gaps
  const ta = Date.parse(prev.startedAt);
  const tb = Date.parse(curr.startedAt);
  if (Number.isFinite(ta) && Number.isFinite(tb)) {
    return tb - ta >= 90_000;
  }
  return false;
}

type SidebarItem = { kind: "sep" } | { kind: "cmd"; index: number };

function buildSidebarItems(cmds: CommandRow[]): SidebarItem[] {
  const items: SidebarItem[] = [];
  for (let i = 0; i < cmds.length; i++) {
    if (i > 0 && isNewPrompt(cmds[i - 1]!, cmds[i]!)) {
      items.push({ kind: "sep" });
    }
    items.push({ kind: "cmd", index: i });
  }
  return items;
}

/** Short label for sidebar from cleaned command (no truncation — caller clips). */
function sidebarLabelText(command: string): string {
  const { label } = cleanCommand(command);
  const flat = label.replace(/\s+/g, " ").trim();
  if (!flat) return "(cmd)";
  if (flat.includes(" steps ") || /\d+\s+steps\s+·/.test(flat)) return flat;
  const first = flat.split(" ")[0] ?? flat;
  const base = first.includes("/") ? (first.split("/").pop() ?? first) : first;
  const rest = flat.slice(first.length).trim();
  return rest ? `${base} ${rest}` : base;
}

/** Fit plain text into `n` columns, trailing with `...` when clipped. */
function truncatePlain(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  if (n <= 3) return ".".repeat(n);
  return s.slice(0, n - 3) + "...";
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLen(s: string): number {
  return stripAnsi(s).length;
}

/** Clip a possibly-styled string to exactly n visible columns. */
function clipVisible(s: string, n: number): string {
  const plain = stripAnsi(s);
  if (plain.length <= n) return s + " ".repeat(n - plain.length);
  return truncatePlain(plain, n);
}

function homeify(p?: string): string {
  if (!p) return "";
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

function buildPanelLines(cmd: CommandRow | undefined, width: number): string[] {
  if (!cmd) {
    return [`${DIM}  select a command from the sidebar${RESET}`];
  }

  const cwd = homeify(cmd.cwd) || ".";
  const cleaned = cleanCommand(cmd.command);
  const lines: string[] = [];

  // Ghostty-style prompt: ~/path % command  (then stdout below)
  const promptMark = cmd.running
    ? `${YELLOW}%${RESET}`
    : cmd.exitCode && cmd.exitCode !== 0
      ? `${RED}%${RESET}`
      : `${GREEN}%${RESET}`;

  const promptPrefix = `${DIM}${cwd}${RESET} ${promptMark} `;
  const cmdLines = cleaned.display.split("\n");
  for (let li = 0; li < cmdLines.length; li++) {
    const line = cmdLines[li]!;
    const prefix = li === 0 ? promptPrefix : "  ";
    const wrapW = Math.max(8, width - visibleLen(prefix) - 1);
    let remaining = line;
    let firstChunk = true;
    while (remaining.length > 0 || firstChunk) {
      const chunk = remaining.slice(0, wrapW);
      remaining = remaining.slice(wrapW);
      // Command in cyan so it stands apart from stdout
      lines.push(
        `${firstChunk ? prefix : "  "}${CYAN}${BOLD}${chunk}${RESET}`,
      );
      firstChunk = false;
      if (!remaining) break;
    }
  }

  if (cleaned.display !== cleaned.raw && cleaned.raw.includes("export PATH")) {
    lines.push(`${DIM}(env preamble hidden)${RESET}`);
  }

  lines.push("");

  // Stdout — default fg (preserves any ANSI in captured output)
  if (cmd.running && !cmd.output) {
    lines.push(runningBannerLine());
  } else if (!cmd.output) {
    lines.push(`${DIM}(no output)${RESET}`);
  } else {
    for (const line of cmd.output.replace(/\n$/, "").split("\n")) {
      // Soft dim only when the line has no its own colors
      if (line.includes("\x1b[")) {
        lines.push(line);
      } else {
        lines.push(`${DIM}${line}${RESET}`);
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

/**
 * Turborepo-style TUI: left = truncated commands, right = cwd + full command + output.
 */
export async function viewSession(id: string): Promise<void> {
  upsertSession(id, {});
  const session = getSession(id);
  const eventsPath = session?.eventsPath ?? sessionEventsPath(id);

  if (!existsSync(eventsPath)) {
    console.error(`No events for session ${id} at ${eventsPath}`);
    process.exitCode = 1;
    return;
  }

  let selected = 0;
  let followLatest = true;
  let outputScroll = 0;
  let sidebarScroll = 0;
  let lastSize = -1;
  let cmds: CommandRow[] = [];
  let title =
    resolveSessionTitle({
      conversationId: id,
      workspace: session?.workspace,
      hint: session?.title,
    }) || session?.title || `agent-${shortId(id)}`;
  let lastTitleSet = "";

  const applyTitle = (next: string) => {
    if (!next || next === lastTitleSet) return;
    title = next;
    lastTitleSet = next;
    setTerminalTitle(next);
    const s = getSession(id);
    setGhosttyTitles({
      terminalId: s?.terminalId,
      tabTitle: next,
      windowTitle: next,
    });
    upsertSession(id, { title: next });
  };

  applyTitle(title);

  const stdin = process.stdin;
  const stdout = process.stdout;

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdout.write(HIDE);

  const refresh = () => {
    const events = loadEvents(id);
    cmds = eventsToCommands(events);
    const startEv = events.find((e) => e.type === "session_start");
    const fromCursor = resolveSessionTitle({
      conversationId: id,
      workspace: getSession(id)?.workspace,
    });
    if (fromCursor) applyTitle(fromCursor);
    else if (startEv && startEv.type === "session_start") applyTitle(startEv.title);

    if (followLatest && cmds.length) {
      selected = cmds.length - 1;
      outputScroll = 0;
    }
    if (selected >= cmds.length) selected = Math.max(0, cmds.length - 1);
    draw();
  };

  const draw = () => {
    const rows = stdout.rows || 24;
    const cols = stdout.columns || 80;
    const sidebarW = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.floor(cols * 0.28)));
    const rightW = Math.max(24, cols - sidebarW - 1);
    const headerRows = 1;
    const footerRows = 1;
    const bodyRows = Math.max(1, rows - headerRows - footerRows);

    const sidebarItems = buildSidebarItems(cmds);
    const selectedItem = sidebarItems.findIndex(
      (it) => it.kind === "cmd" && it.index === selected,
    );
    // Keep selection visible in sidebar (item scroll includes separators)
    if (selectedItem >= 0) {
      if (selectedItem < sidebarScroll) sidebarScroll = selectedItem;
      if (selectedItem >= sidebarScroll + bodyRows) {
        sidebarScroll = selectedItem - bodyRows + 1;
      }
    }

    const current = cmds[selected];
    const panelLines = buildPanelLines(current, rightW);
    const maxScroll = Math.max(0, panelLines.length - bodyRows);
    if (outputScroll > maxScroll) outputScroll = maxScroll;

    const lines: string[] = [];

    // Title bar — bold default fg (theme foreground)
    const mode = followLatest ? "follow" : "pinned";
    lines.push(
      `${BOLD}${truncatePlain(title, Math.max(10, cols - 24))}${RESET}${DIM}  ${cmds.length} cmds · ${mode}${RESET}`,
    );

    for (let i = 0; i < bodyRows; i++) {
      const item = sidebarItems[sidebarScroll + i];
      let left: string;

      if (!item) {
        left = " ".repeat(sidebarW);
      } else if (item.kind === "sep") {
        left = `${DIM}${"─".repeat(sidebarW)}${RESET}`;
      } else {
        const cmd = cmds[item.index]!;
        const active = item.index === selected;
        const icon = statusGlyph(cmd, active);
        const prefixW = 4;
        const labelW = Math.max(0, sidebarW - prefixW);
        const label = truncatePlain(sidebarLabelText(cmd.command), labelW);
        if (active) {
          const core = `▌ ${icon} ${BOLD}${label}`;
          left = `${REVERSE}${clipVisible(core, sidebarW)}${RESET}`;
        } else {
          left = clipVisible(`  ${icon} ${DIM}${label}${RESET}`, sidebarW);
        }
      }

      const panelLine = panelLines[i + outputScroll] ?? "";
      const rightPlain = panelLine.replace(/\x1b\[[0-9;]*m/g, "");
      const right =
        rightPlain.length >= rightW
          ? truncateStyled(panelLine, rightW)
          : panelLine + " ".repeat(rightW - rightPlain.length);

      lines.push(`${left}${DIM}│${RESET}${right}`);
    }

    const cwdHint = current ? homeify(current.cwd) || "." : "";
    const footer = current
      ? ` ↑↓ select  u/d scroll pane  f follow  i shell  q quit  ${DIM}${cwdHint}${RESET}`
      : ` waiting for shell commands…  i shell  q quit `;
    lines.push(`${DIM}${truncatePlain(footer.replace(/\x1b\[[0-9;]*m/g, ""), cols)}${RESET}`);

    stdout.write(CLEAR + lines.join("\n"));
  };

  let poll = setInterval(() => {
    try {
      const size = statSync(eventsPath).size;
      if (size !== lastSize) {
        lastSize = size;
        refresh();
        return;
      }
    } catch {
      // ignore
    }
    if (cmds.some((c) => c.running)) draw();
  }, 120);

  const onResize = () => draw();
  stdout.on("resize", onResize);

  // Interactive shell lives in a Ghostty split — main pane stays read-only output.
  let shellTerminalId = getSession(id)?.shellTerminalId;
  let lastShellCwd = "";

  const resolveTargetCwd = (cwd?: string) =>
    (cwd && existsSync(cwd) ? cwd : undefined) ||
    getSession(id)?.workspace ||
    session?.workspace ||
    process.cwd();

  /** Open/reuse a right Ghostty split shell at cwd and focus it. */
  const openShellSplit = (cwd?: string) => {
    const target = resolveTargetCwd(cwd);
    const viewerId = getSession(id)?.terminalId;
    const result = ensureShellSplit({
      viewerTerminalId: viewerId,
      shellTerminalId,
      cwd: target,
    });
    if (!result.ok || !result.shellTerminalId) return;

    shellTerminalId = result.shellTerminalId;
    upsertSession(id, { shellTerminalId });

    if (!result.created && target !== lastShellCwd) {
      shellCd({ shellTerminalId, cwd: target });
    }
    lastShellCwd = target;
    focusShell(shellTerminalId);
  };

  const onData = (key: string) => {
    if (key === "\u0003" || key === "q") {
      cleanup();
      resolvePromise();
      return;
    }
    // Explicit only — selecting a command never makes the main (output) pane interactive
    if (key === "i") {
      openShellSplit(cmds[selected]?.cwd);
      return;
    }
    if (key === "I") {
      openShellSplit(getSession(id)?.workspace || session?.workspace);
      return;
    }
    if (key === "\u001b[A" || key === "k") {
      followLatest = false;
      selected = Math.max(0, selected - 1);
      outputScroll = 0;
      draw();
    } else if (key === "\u001b[B" || key === "j") {
      followLatest = false;
      selected = Math.min(Math.max(0, cmds.length - 1), selected + 1);
      outputScroll = 0;
      draw();
    } else if (key === "u" || key === "\u001b[5~") {
      // u / PgUp — scroll main pane up (unpin follow so refresh doesn't reset)
      followLatest = false;
      outputScroll = Math.max(0, outputScroll - 3);
      draw();
    } else if (key === "d" || key === "\u001b[6~") {
      // d / PgDn — scroll main pane down
      followLatest = false;
      outputScroll += 3;
      draw();
    } else if (key === "f") {
      followLatest = true;
      refresh();
    } else if (key === "g") {
      followLatest = false;
      selected = 0;
      outputScroll = 0;
      draw();
    } else if (key === "G") {
      followLatest = false;
      selected = Math.max(0, cmds.length - 1);
      outputScroll = 0;
      draw();
    }
  };

  let resolvePromise!: () => void;

  const cleanup = () => {
    clearInterval(poll);
    stdin.off("data", onData);
    stdout.off("resize", onResize);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdout.write(SHOW + CLEAR);
  };

  refresh();

  await new Promise<void>((resolve) => {
    resolvePromise = resolve;
    stdin.on("data", onData);
    process.on("SIGINT", () => {
      cleanup();
      resolve();
    });
    process.on("SIGTERM", () => {
      cleanup();
      resolve();
    });
  });
}

/** Truncate a string that may contain ANSI, by visible width. */
function truncateStyled(s: string, n: number): string {
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
