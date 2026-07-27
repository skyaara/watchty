import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { openSessionTab, focusSessionTab, terminalAlive } from "./ghostty";
import { resolveSessionTitle } from "./session-name";
import { resolvedSettings } from "./config";
import { maybeAutoCleanup } from "./cleanup";
import {
  appendEvent,
  claimViewer,
  getSession,
  releaseViewer,
  resolveWorkspace,
  setPendingCmd,
  takePendingCmd,
  upsertSession,
} from "./store";

export type HookPayload = {
  hook_event_name?: string;
  conversation_id?: string;
  generation_id?: string;
  workspace_roots?: string[];
  cwd?: string;
  command?: string;
  output?: string;
  // Optional name fields if Cursor ever sends them
  session_name?: string;
  title?: string;
  name?: string;
  conversation_title?: string;
  exit_code?: number | null;
  exitCode?: number | null;
  duration?: number;
  duration_ms?: number;
  durationMs?: number;
  [key: string]: unknown;
};

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

function refreshTitle(sessionId: string, workspace?: string, hint?: string): string {
  const title = resolveSessionTitle({
    conversationId: sessionId,
    workspace,
    hint,
  });
  upsertSession(sessionId, { title, workspace });
  return title;
}

/**
 * Open at most one Ghostty tab per conversation_id (lock file prevents races
 * between sessionStart and beforeShellExecution).
 * If the previous tab was closed (dead terminalId), clear the claim and reopen.
 * In-flight claims (viewerClaimed / lock, no terminal yet) are left alone.
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
  // spawn a second Ghostty tab (sessionStart vs beforeShellExecution).
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
      workspace,
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
  if (event === "sessionStart" || event === "sessionEnd" || event === "stop") {
    maybeAutoCleanup();
  }

  const workspace = resolveWorkspace(payload.workspace_roots);
  const hint = hintFromPayload(payload);
  const now = new Date().toISOString();

  switch (event) {
    case "sessionStart": {
      const title = refreshTitle(id, workspace, hint);
      appendEvent(id, {
        type: "session_start",
        at: now,
        title,
        workspace,
      });
      ensureTab(id, workspace, hint);
      break;
    }
    case "beforeShellExecution": {
      const cmdId = randomUUID().slice(0, 8);
      const command = payload.command ?? "(unknown)";
      refreshTitle(id, workspace, hint);
      appendEvent(id, {
        type: "cmd_start",
        id: cmdId,
        at: now,
        command,
        cwd: payload.cwd || workspace,
        generationId:
          typeof payload.generation_id === "string" && payload.generation_id
            ? payload.generation_id
            : undefined,
      });
      setPendingCmd(id, cmdId);
      ensureTab(id, workspace, hint);
      if (shouldFocus()) {
        const s = getSession(id);
        if (s) focusSessionTab(s);
      }
      process.stdout.write(
        JSON.stringify({ permission: "allow", continue: true }) + "\n",
      );
      break;
    }
    case "afterShellExecution": {
      const exitCode = payload.exit_code ?? payload.exitCode ?? null;
      const durationMs =
        payload.duration_ms ?? payload.durationMs ?? payload.duration;
      const cmdId = takePendingCmd(id) ?? randomUUID().slice(0, 8);
      appendEvent(id, {
        type: "cmd_end",
        id: cmdId,
        at: now,
        exitCode,
        durationMs: typeof durationMs === "number" ? durationMs : undefined,
        output: payload.output,
      });
      refreshTitle(id, workspace, hint);
      break;
    }
    case "sessionEnd":
    case "stop": {
      appendEvent(id, { type: "session_end", at: now });
      upsertSession(id, {
        workspace,
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
