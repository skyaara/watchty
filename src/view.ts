import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { setGhosttyTitles, ensureShellSplit, shellCd, focusShell } from "./ghostty";
import { shortId } from "./paths";
import { resolveSessionTitle, setTerminalTitle } from "./session-name";
import {
  BOLD,
  DIM,
  RESET,
  buildPanelLines,
  buildPromptHeader,
  buildSidebarItems,
  clipVisible,
  homeify,
  sidebarLabelText,
  statusGlyph,
  truncatePlain,
  truncateStyled,
} from "./view-layout";
import {
  eventsToCommands,
  eventsToPrompts,
  getSession,
  loadEvents,
  releaseViewer,
  sessionEventsPath,
  upsertSession,
  type CommandRow,
  type PromptInfo,
} from "./store";

/** Set by Ghostty when hooks auto-open a dedicated viewer surface. */
const OWNED_SURFACE = process.env.WATCHTY_OWNED_SURFACE === "1";

const REVERSE = "\x1b[7m";
const CLEAR = "\x1b[2J\x1b[H";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

const SIDEBAR_MAX = 28;
const SIDEBAR_MIN = 18;

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
  let promptsByGen = new Map<string, PromptInfo>();
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
    promptsByGen = eventsToPrompts(events);
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

    const sidebarItems = buildSidebarItems(cmds, promptsByGen);
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
    const promptInfo = current?.generationId
      ? promptsByGen.get(current.generationId)
      : undefined;
    const promptHeader = buildPromptHeader(
      promptInfo?.prompt,
      rightW,
      undefined,
      promptInfo?.model,
    );
    const promptRows = promptHeader.length;
    const panelBodyRows = Math.max(1, bodyRows - promptRows);

    const panelLines = buildPanelLines(current, rightW);
    const maxScroll = Math.max(0, panelLines.length - panelBodyRows);
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
      } else if (item.kind === "rule") {
        left = `${DIM}${"─".repeat(sidebarW)}${RESET}`;
      } else if (item.kind === "prompt") {
        // Label only — do not extend ─ into leftover sidebar width
        const nextCmd = sidebarItems
          .slice(sidebarScroll + i + 1)
          .find((it) => it.kind === "cmd");
        const nextIdx = nextCmd && nextCmd.kind === "cmd" ? nextCmd.index : -1;
        const gen = nextIdx >= 0 ? cmds[nextIdx]?.generationId : undefined;
        const sepPrompt = gen ? promptsByGen.get(gen)?.prompt : undefined;
        if (sepPrompt) {
          const label = truncatePlain(
            ` ${sepPrompt.replace(/\s+/g, " ")} `,
            sidebarW,
          );
          // Default fg + bold — theme foreground, not a palette slot
          left = clipVisible(`${BOLD}${label}${RESET}`, sidebarW);
        } else {
          left = " ".repeat(sidebarW);
        }
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

      let panelLine: string;
      if (i < promptRows) {
        panelLine = promptHeader[i]!;
      } else {
        panelLine = panelLines[i - promptRows + outputScroll] ?? "";
      }
      const rightPlain = panelLine.replace(/\x1b\[[0-9;]*m/g, "");
      const right =
        rightPlain.length >= rightW
          ? truncateStyled(panelLine, rightW)
          : panelLine + " ".repeat(rightW - rightPlain.length);

      lines.push(`${left}${DIM}│${RESET}${right}`);
    }

    const cwdHint = current ? homeify(current.cwd) || "." : "";
    const quitHint = OWNED_SURFACE ? "q shell" : "q quit";
    const footer = current
      ? ` ↑↓ select  u/d scroll pane  f follow  i shell  ${quitHint}  ${DIM}${cwdHint}${RESET}`
      : ` waiting for shell commands…  i shell  ${quitHint} `;
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

  /**
   * Leave the TUI for a normal shell.
   * - Auto-opened Ghostty surface: replace this process with a login shell in the same pane
   *   (parent is Ghostty, not zsh — safe). Split+exit closes the whole tab.
   * - Manual `watchty view`: restore TTY and return to the parent shell (never nest a shell —
   *   that races zsh job control → "suspended (tty input)").
   */
  const quit = () => {
    const cwd = resolveTargetCwd(cmds[selected]?.cwd);
    cleanup();

    if (OWNED_SURFACE) {
      // Prefer an existing `i` shell split: focus it and let this surface exit.
      if (shellTerminalId) {
        const result = ensureShellSplit({
          viewerTerminalId: getSession(id)?.terminalId,
          shellTerminalId,
          cwd,
        });
        if (result.ok && result.shellTerminalId) {
          if (!result.created && cwd !== lastShellCwd) {
            shellCd({ shellTerminalId: result.shellTerminalId, cwd });
          }
          focusShell(result.shellTerminalId);
          releaseViewer(id);
          process.exit(0);
        }
      }

      releaseViewer(id);
      try {
        process.chdir(cwd);
      } catch {
        // keep cwd
      }
      // Pause so we are not competing with the child for the TTY.
      if (stdin.isTTY) stdin.pause();
      const shell = process.env.SHELL || "/bin/zsh";
      const result = spawnSync(shell, ["-l"], {
        stdio: "inherit",
        cwd,
        env: process.env,
      });
      process.exit(result.status ?? 1);
    }

    // Pull-mode: optional focus of an `i` split, then return to the calling shell.
    if (shellTerminalId) {
      const result = ensureShellSplit({
        viewerTerminalId: getSession(id)?.terminalId,
        shellTerminalId,
        cwd,
      });
      if (result.ok && result.shellTerminalId) {
        if (!result.created && cwd !== lastShellCwd) {
          shellCd({ shellTerminalId: result.shellTerminalId, cwd });
        }
        focusShell(result.shellTerminalId);
      }
    }
    resolvePromise();
  };

  const onData = (key: string) => {
    if (key === "\u0003" || key === "q") {
      quit();
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
    // Show cursor + clear TUI. Trailing newline helps the parent shell redraw a prompt.
    stdout.write(SHOW + CLEAR + "\n");
  };

  refresh();

  await new Promise<void>((resolve) => {
    resolvePromise = resolve;
    stdin.on("data", onData);
    process.on("SIGINT", () => quit());
    process.on("SIGTERM", () => quit());
  });
}
