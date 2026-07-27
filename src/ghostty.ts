import { spawnSync } from "node:child_process";

export type OpenTabResult = {
  ok: boolean;
  tabId?: string;
  terminalId?: string;
  windowId?: string;
  error?: string;
};

function runOsascript(script: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim() || result.error?.message || "",
  };
}

function escapeAs(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Set Ghostty surface titles via actions (AppleScript `name` is not writable).
 * On macOS, window title tracks the selected tab title.
 */
export function setGhosttyTitles(opts: {
  terminalId?: string;
  tabTitle: string;
  windowTitle?: string;
}): { ok: boolean; error?: string } {
  const tab = escapeAs(opts.tabTitle.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120));
  // Prefer combined title so the window chrome shows the workspace name too
  const win = escapeAs(
    (opts.windowTitle ?? opts.tabTitle).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120),
  );
  const termClause = opts.terminalId
    ? `set matches to every terminal whose id is "${escapeAs(opts.terminalId)}"
    if (count of matches) is 0 then return "missing"
    set term to item 1 of matches`
    : `set term to focused terminal of selected tab of front window`;

  const script = `
tell application "Ghostty"
  try
    ${termClause}
    perform action "set_tab_title:${tab}" on term
    perform action "set_title:${win}" on term
    return "ok"
  on error errMsg
    return "ERR\t" & errMsg
  end try
end tell
`;
  const { ok, stdout, stderr } = runOsascript(script);
  if (!ok) return { ok: false, error: stderr || "osascript failed" };
  if (stdout === "missing") return { ok: false, error: "terminal not found" };
  if (stdout.startsWith("ERR\t")) return { ok: false, error: stdout.slice(4) };
  return { ok: true };
}

/**
 * Open exactly one Ghostty tab whose surface command is the turbo-style viewer.
 * Prefer surface `command` over input text. Capture ids from the created tab,
 * not "selected tab" (which can still be the previous tab).
 *
 * When Ghostty already has a window, new tabs open without switching away from
 * the tab you were on (Ghostty auto-selects new tabs — we restore the previous).
 * Pass `select: true` (focus config) to jump to the new session tab.
 * `background` skips `activate` so Cursor/the current app keeps focus.
 */
export function openSessionTab(opts: {
  command: string;
  title: string;
  cwd?: string;
  background?: boolean;
  /** Jump to the new tab (default false — stay on whatever tab was selected). */
  select?: boolean;
}): OpenTabResult {
  const cmd = escapeAs(opts.command);
  const cwd = opts.cwd ? escapeAs(opts.cwd) : "";
  const titleText = escapeAs(
    opts.title.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120),
  );
  const background = Boolean(opts.background);
  const selectNew = Boolean(opts.select);

  const script = `
tell application "Ghostty"
  ${background ? "" : "activate"}
  set cfg to new surface configuration
  set command of cfg to "${cmd}"
  ${cwd ? `set initial working directory of cfg to "${cwd}"` : ""}

  set winCount to count of windows
  set createdTab to missing value
  set createdWin to missing value
  set prevTab to missing value

  if winCount is 0 then
    set createdWin to new window with configuration cfg
    set createdTab to selected tab of createdWin
  else
    set createdWin to front window
    try
      set prevTab to selected tab of createdWin
    end try
    try
      set createdTab to new tab in createdWin with configuration cfg
    on error
      set createdWin to new window with configuration cfg
      set createdTab to selected tab of createdWin
      set prevTab to missing value
    end try
  end if

  try
    delay 0.15
    set termRef to focused terminal of createdTab
    set titleText to "${titleText}"
    try
      perform action "set_tab_title:" & titleText on termRef
      perform action "set_title:" & titleText on termRef
    end try

    -- Stay on the user's current tab unless they asked to focus the new one.
    -- Ghostty usually auto-selects a newly created tab, so restore prevTab.
    if ${selectNew ? "true" : "false"} then
      select tab createdTab
    else if prevTab is not missing value then
      try
        select tab prevTab
      end try
    end if

    set tid to id of createdTab as string
    set termid to id of termRef as string
    set wid to id of createdWin as string
    return tid & "\t" & termid & "\t" & wid
  on error errMsg
    return "ERR\t" & errMsg
  end try
end tell
`;

  const { ok, stdout, stderr } = runOsascript(script);
  if (!ok) {
    return { ok: false, error: stderr || stdout || "osascript failed" };
  }
  if (stdout.startsWith("ERR\t")) {
    return { ok: false, error: stdout.slice(4) };
  }
  const [tabId, terminalId, windowId] = stdout.split("\t");
  return {
    ok: true,
    tabId: tabId || undefined,
    terminalId: terminalId || undefined,
    windowId: windowId || undefined,
  };
}

/** True when a Ghostty terminal id still refers to a live surface. */
export function terminalAlive(terminalId?: string): boolean {
  if (!terminalId) return false;
  const id = escapeAs(terminalId);
  const script = `
tell application "Ghostty"
  try
    set matches to every terminal whose id is "${id}"
    if (count of matches) > 0 then return "yes"
  end try
  return "no"
end tell
`;
  const { ok, stdout } = runOsascript(script);
  return ok && stdout === "yes";
}

export function focusSessionTab(opts: {
  tabId?: string;
  terminalId?: string;
  windowId?: string;
}): { ok: boolean; error?: string } {
  if (!opts.terminalId && !opts.tabId) {
    return { ok: false, error: "no tab/terminal id stored" };
  }

  const termId = opts.terminalId ? escapeAs(opts.terminalId) : "";
  const tabId = opts.tabId ? escapeAs(opts.tabId) : "";

  const script = termId
    ? `
tell application "Ghostty"
  try
    set matches to every terminal whose id is "${termId}"
    if (count of matches) > 0 then
      focus item 1 of matches
      return "ok"
    end if
  end try
  return "missing"
end tell
`
    : `
tell application "Ghostty"
  try
    repeat with w in windows
      repeat with t in tabs of w
        try
          if (id of t as string) is "${tabId}" then
            select tab t
            return "ok"
          end if
        end try
      end repeat
    end repeat
  end try
  return "missing"
end tell
`;

  const { ok, stdout, stderr } = runOsascript(script);
  if (!ok) return { ok: false, error: stderr || "osascript failed" };
  if (stdout === "missing") return { ok: false, error: "tab not found" };
  return { ok: true };
}

/**
 * Ensure a right-hand Ghostty split with an interactive shell at `cwd`.
 * Reuses an existing shell terminal when `shellTerminalId` is still alive.
 */
export function ensureShellSplit(opts: {
  viewerTerminalId?: string;
  shellTerminalId?: string;
  cwd: string;
}): { ok: boolean; shellTerminalId?: string; created: boolean; error?: string } {
  const cwd = escapeAs(opts.cwd);
  const shell = escapeAs(process.env.SHELL || "/bin/zsh");
  const viewerId = opts.viewerTerminalId ? escapeAs(opts.viewerTerminalId) : "";
  const existingShell = opts.shellTerminalId ? escapeAs(opts.shellTerminalId) : "";

  const script = `
tell application "Ghostty"
  try
    -- Reuse existing shell split if it still exists
    ${
      existingShell
        ? `
    set existing to every terminal whose id is "${existingShell}"
    if (count of existing) > 0 then
      return "EXIST\t" & (id of item 1 of existing as string)
    end if
    `
        : ""
    }

    set viewer to missing value
    ${
      viewerId
        ? `
    set vmatches to every terminal whose id is "${viewerId}"
    if (count of vmatches) > 0 then set viewer to item 1 of vmatches
    `
        : ""
    }
    if viewer is missing value then
      set viewer to focused terminal of selected tab of front window
    end if

    set cfg to new surface configuration
    set initial working directory of cfg to "${cwd}"
    -- default login shell surface
    set command of cfg to "${shell}"

    set shellTerm to split viewer direction right with configuration cfg
    delay 0.2
    return "NEW\t" & (id of shellTerm as string)
  on error errMsg
    return "ERR\t" & errMsg
  end try
end tell
`;

  const { ok, stdout, stderr } = runOsascript(script);
  if (!ok) return { ok: false, created: false, error: stderr || "osascript failed" };
  if (stdout.startsWith("ERR\t")) {
    return { ok: false, created: false, error: stdout.slice(4) };
  }
  if (stdout.startsWith("EXIST\t")) {
    return { ok: true, created: false, shellTerminalId: stdout.slice(6) };
  }
  if (stdout.startsWith("NEW\t")) {
    return { ok: true, created: true, shellTerminalId: stdout.slice(4) };
  }
  return { ok: false, created: false, error: stdout || "unknown response" };
}

/** cd the interactive shell pane to a directory (does not steal focus). */
export function shellCd(opts: {
  shellTerminalId: string;
  cwd: string;
}): { ok: boolean; error?: string } {
  const id = escapeAs(opts.shellTerminalId);
  const cwd = opts.cwd.replace(/'/g, `'\\''`);

  const script = `
tell application "Ghostty"
  try
    set matches to every terminal whose id is "${id}"
    if (count of matches) is 0 then return "missing"
    set term to item 1 of matches
    input text "cd '${cwd}'" & return to term
    return "ok"
  on error errMsg
    return "ERR\t" & errMsg
  end try
end tell
`;
  const { ok, stdout, stderr } = runOsascript(script);
  if (!ok) return { ok: false, error: stderr || "osascript failed" };
  if (stdout === "missing") return { ok: false, error: "shell pane gone" };
  if (stdout.startsWith("ERR\t")) return { ok: false, error: stdout.slice(4) };
  return { ok: true };
}

/** Focus the interactive shell split. */
export function focusShell(shellTerminalId: string): { ok: boolean; error?: string } {
  return focusSessionTab({ terminalId: shellTerminalId });
}

export function ghosttyAvailable(): { ok: boolean; detail: string } {
  const version = runOsascript('tell application "Ghostty" to get version');
  if (version.ok && version.stdout) {
    return { ok: true, detail: `Ghostty ${version.stdout}` };
  }
  return {
    ok: false,
    detail: version.stderr || "Ghostty AppleScript unavailable (install Ghostty ≥ 1.3, allow Automation)",
  };
}
