import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { openSessionTab, focusSessionTab, terminalAlive } from "./ghostty";
import { resolveSessionTitle } from "./session-name";
import { resolvedSettings } from "./config";
import { maybeAutoCleanup } from "./cleanup";
import { detectCursorWorkspace } from "./workspace";
import {
  appendEvent,
  claimViewer,
  getSession,
  releaseViewer,
  upsertSession,
} from "./store";

export type HookPayload = {
  hook_event_name?: string;
  conversation_id?: string;
  generation_id?: string;
  workspace_roots?: string[];
  cwd?: string;
  /** User message text from beforeSubmitPrompt */
  prompt?: string;
  /** preToolUse / postToolUse — Cursor Shell (or Claude Bash) tool name */
  tool_name?: string;
  /** Stable id shared by pre/post for the same tool call */
  tool_use_id?: string;
  /** Shell: { command, working_directory? } */
  tool_input?: unknown;
  /** postToolUse: JSON string (or object) with exitCode / stdout / stderr */
  tool_output?: unknown;
  error_message?: string;
  failure_type?: string;
  // Optional name fields if Cursor ever sends them
  session_name?: string;
  title?: string;
  name?: string;
  conversation_title?: string;
  duration?: number;
  duration_ms?: number;
  durationMs?: number;
  [key: string]: unknown;
};

/** Cursor Shell + Claude Bash (third-party hook compat). */
function isShellTool(payload: HookPayload): boolean {
  const name = payload.tool_name;
  if (typeof name !== "string" || !name.trim()) return true;
  const n = name.trim();
  return n === "Shell" || n === "Bash";
}

function toolUseId(payload: HookPayload): string {
  if (typeof payload.tool_use_id === "string" && payload.tool_use_id.trim()) {
    return payload.tool_use_id.trim();
  }
  return randomUUID().slice(0, 8);
}

function shellCommand(payload: HookPayload): string {
  const input = payload.tool_input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const cmd = (input as Record<string, unknown>).command;
    if (typeof cmd === "string" && cmd) return cmd;
  }
  return "(unknown)";
}

function shellCwd(
  payload: HookPayload,
  workspace?: string,
): string | undefined {
  if (typeof payload.cwd === "string" && payload.cwd.trim()) {
    return payload.cwd.trim();
  }
  const input = payload.tool_input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>;
    const wd = rec.working_directory ?? rec.workingDirectory;
    if (typeof wd === "string" && wd.trim()) return wd.trim();
  }
  return workspace;
}

function durationMsOf(payload: HookPayload): number | undefined {
  const d = payload.duration_ms ?? payload.durationMs ?? payload.duration;
  return typeof d === "number" ? d : undefined;
}

/** Normalize postToolUse tool_output into exit code + display text. */
function shellResult(payload: HookPayload): {
  exitCode: number | null;
  output?: string;
} {
  let raw: unknown = payload.tool_output;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { exitCode: null, output: raw };
    }
  }

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const exitCode =
      typeof o.exitCode === "number"
        ? o.exitCode
        : typeof o.exit_code === "number"
          ? o.exit_code
          : null;
    const stdout = typeof o.stdout === "string" ? o.stdout : "";
    const stderr = typeof o.stderr === "string" ? o.stderr : "";
    let output: string | undefined;
    if ("stdout" in o || "stderr" in o) {
      output = stdout && stderr ? `${stdout}\n${stderr}` : stdout || stderr;
    } else if (typeof o.output === "string") {
      output = o.output;
    }
    return { exitCode, output };
  }

  return { exitCode: null, output: undefined };
}

function bunAbsolute(): string {
  const fromHome = join(process.env.HOME ?? "", ".bun", "bin", "bun");
  if (existsSync(fromHome)) return fromHome;
  const which = Bun.which("bun");
  if (which) return which;
  return process.execPath;
}

function cliAbsolute(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cli.ts");
}

/** Invocation safe under Ghostty's --noprofile --norc login shell. */
function selfBin(): string {
  return `${bunAbsolute()} ${cliAbsolute()}`;
}

function viewCommand(sessionId: string): string {
  return `${selfBin()} view ${sessionId}`;
}

function shouldFocus(): boolean {
  return resolvedSettings().focus;
}

/** Open Ghostty tabs without activate/select (keep current app focused). */
function shouldBackground(): boolean {
  return resolvedSettings().background;
}

/**
 * When false, hooks only write jsonl — open the viewer yourself from Ghostty:
 *   watchty list
 *   watchty view          # latest live session
 *   watchty view <id>
 */
function shouldAutoOpen(): boolean {
  return resolvedSettings().autoOpen;
}

function hintFromPayload(payload: HookPayload): string | undefined {
  const hint =
    payload.session_name ??
    payload.conversation_title ??
    payload.title ??
    payload.name;
  return typeof hint === "string" && hint.trim() ? hint.trim() : undefined;
}

/** Prefer legacy `model` slug; fall back to structured `model_id`. */
function modelFromPayload(payload: HookPayload): string | undefined {
  if (typeof payload.model === "string" && payload.model.trim()) {
    return payload.model.trim();
  }
  if (typeof payload.model_id === "string" && payload.model_id.trim()) {
    return payload.model_id.trim();
  }
  return undefined;
}

/**
 * Prefer Cursor workspace_roots; fall back to detecting a project from cwd.
 * sessionStart on a brand-new chat often omits workspace_roots.
 */
function workspaceFromPayload(payload: HookPayload): string | undefined {
  const roots = payload.workspace_roots;
  if (roots?.length) return roots[0];
  if (typeof payload.cwd === "string" && payload.cwd.trim()) {
    const fromCwd = detectCursorWorkspace(payload.cwd.trim());
    if (fromCwd) return fromCwd;
  }
  return detectCursorWorkspace(process.cwd());
}

function refreshTitle(sessionId: string, workspace?: string, hint?: string): string {
  const title = resolveSessionTitle({
    conversationId: sessionId,
    workspace,
    hint,
  });
  // Omit undefined workspace so a later hook without workspace_roots does not
  // wipe a path stored from an earlier event.
  upsertSession(sessionId, {
    title,
    ...(workspace !== undefined ? { workspace } : {}),
  });
  return title;
}

/**
 * Open at most one Ghostty tab per conversation_id (lock file prevents races
 * between beforeSubmitPrompt and preToolUse).
 * If the previous tab was closed (dead terminalId), clear the claim and reopen.
 * In-flight claims (viewerClaimed / lock, no terminal yet) are left alone.
 *
 * Called on first prompt / shell — not sessionStart — so empty new-chat tabs
 * (agent-{hash} with no title or commands) never open, and a later prompt
 * can't orphan a stale tab by opening a second one.
 *
 * With WATCHTY_AUTO_OPEN=0, skip opening — events still land in jsonl
 * for a pull-based `watchty view` from Ghostty.
 */
function ensureTab(sessionId: string, workspace?: string, hint?: string): void {
  const existing = getSession(sessionId);

  // Live viewer — keep using it (never open a second tab).
  if (existing?.terminalId && terminalAlive(existing.terminalId)) {
    refreshTitle(sessionId, workspace ?? existing.workspace, hint);
    return;
  }

  if (!shouldAutoOpen()) {
    refreshTitle(sessionId, workspace ?? existing?.workspace, hint);
    return;
  }

  // Only release when we know the previous tab is dead. Never release merely
  // because viewerClaimed is set — that races with an in-flight open and can
  // spawn a second Ghostty tab (beforeSubmitPrompt vs preToolUse).
  if (existing?.terminalId) {
    releaseViewer(sessionId);
  }

  if (!claimViewer(sessionId)) {
    // Another hook owns the live or in-flight claim.
    refreshTitle(sessionId, workspace ?? existing?.workspace, hint);
    return;
  }

  const title = refreshTitle(sessionId, workspace, hint);
  const result = openSessionTab({
    command: viewCommand(sessionId),
    title,
    cwd: workspace,
    // Skip activate when background=true. Never switch away from the user's
    // current Ghostty tab unless focus=true (select).
    background: shouldBackground(),
    select: shouldFocus(),
  });

  if (result.ok) {
    upsertSession(sessionId, {
      title,
      ...(workspace !== undefined ? { workspace } : {}),
      tabId: result.tabId,
      terminalId: result.terminalId,
      windowId: result.windowId,
      viewerClaimed: true,
    });
  } else {
    releaseViewer(sessionId);
    appendEvent(sessionId, {
      type: "note",
      at: new Date().toISOString(),
      text: `Ghostty tab failed: ${result.error ?? "unknown"} — run: ${viewCommand(sessionId)}`,
    });
  }
}

export async function handleHook(payload: HookPayload): Promise<void> {
  const event = payload.hook_event_name ?? "";
  const id = payload.conversation_id;
  if (!id) return;

  // Throttled TTL cleanup (session boundaries only — cheap no-op most of the time)
  if (event === "sessionStart" || event === "sessionEnd") {
    maybeAutoCleanup();
  }

  const workspace = workspaceFromPayload(payload);
  const hint = hintFromPayload(payload);
  const now = new Date().toISOString();

  switch (event) {
    case "sessionStart": {
      // Record only — do not open Ghostty yet. New chats often have no title /
      // workspace, and opening here leaves a stale agent-{hash} tab when the
      // first prompt later opens a properly named one.
      const title = refreshTitle(id, workspace, hint);
      appendEvent(id, {
        type: "session_start",
        at: now,
        title,
        workspace,
      });
      break;
    }
    case "beforeSubmitPrompt": {
      const generationId =
        typeof payload.generation_id === "string" && payload.generation_id
          ? payload.generation_id
          : undefined;
      const promptText =
        typeof payload.prompt === "string" ? payload.prompt.trim() : "";
      const model = modelFromPayload(payload);
      refreshTitle(id, workspace, hint);
      if (generationId && promptText) {
        appendEvent(id, {
          type: "prompt",
          at: now,
          generationId,
          prompt: promptText,
          ...(model ? { model } : {}),
        });
      }
      // First real attach point: user submitted a prompt (title usually known).
      ensureTab(id, workspace, hint);
      // Always allow — we only observe. Matcher UserPromptSubmit is optional.
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
      break;
    }
    case "preToolUse": {
      if (!isShellTool(payload)) break;
      const cmdId = toolUseId(payload);
      refreshTitle(id, workspace, hint);
      appendEvent(id, {
        type: "cmd_start",
        id: cmdId,
        at: now,
        command: shellCommand(payload),
        cwd: shellCwd(payload, workspace),
        generationId:
          typeof payload.generation_id === "string" && payload.generation_id
            ? payload.generation_id
            : undefined,
      });
      // Fallback if beforeSubmitPrompt isn't hooked (older installs); no-ops
      // when the prompt hook already opened a live tab.
      ensureTab(id, workspace, hint);
      if (shouldFocus()) {
        const s = getSession(id);
        if (s) focusSessionTab(s);
      }
      process.stdout.write(
        JSON.stringify({ permission: "allow" }) + "\n",
      );
      break;
    }
    case "postToolUse": {
      if (!isShellTool(payload)) break;
      const { exitCode, output } = shellResult(payload);
      appendEvent(id, {
        type: "cmd_end",
        id: toolUseId(payload),
        at: now,
        exitCode,
        durationMs: durationMsOf(payload),
        output,
      });
      refreshTitle(id, workspace, hint);
      break;
    }
    case "postToolUseFailure": {
      if (!isShellTool(payload)) break;
      const msg =
        typeof payload.error_message === "string"
          ? payload.error_message
          : payload.failure_type
            ? String(payload.failure_type)
            : undefined;
      appendEvent(id, {
        type: "cmd_end",
        id: toolUseId(payload),
        at: now,
        exitCode: 1,
        durationMs: durationMsOf(payload),
        output: msg,
      });
      refreshTitle(id, workspace, hint);
      break;
    }
    case "sessionEnd": {
      // Composer conversation closed (user_close / window_close / …) — not
      // per-turn `stop`. Tool cmds already end via postToolUse(Failure).
      appendEvent(id, { type: "session_end", at: now });
      upsertSession(id, {
        ...(workspace !== undefined ? { workspace } : {}),
        endedAt: now,
      });
      break;
    }
    default:
      break;
  }
}

export async function readHookPayload(): Promise<HookPayload> {
  const text = await Bun.stdin.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as HookPayload;
  } catch {
    return {};
  }
}

export function packageRoot(): string {
  try {
    return realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
  } catch {
    return join(dirname(fileURLToPath(import.meta.url)), "..");
  }
}

export { selfBin };
