import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "./store";
import { listSessions } from "./store";
import { detectCursorWorkspace } from "./workspace";

function shortName(s: SessionRecord): string {
  const t = s.title;
  return t.includes(" | ") ? t.slice(t.lastIndexOf(" | ") + 3) : t;
}

/**
 * Labels for attaching via `watchty view` / `focus`.
 * Prefer unique chat names; fall back to full title or short id.
 * Live sessions are listed first.
 *
 * Default scope: current Cursor workspace when detectable; else all.
 * Pass workspace=`*` / `all` for everything; or an explicit path/name.
 */
export function sessionAttachSuggestions(
  prefix = "",
  workspace?: string,
): string[] {
  let filter: string | undefined;
  if (workspace === "*" || workspace === "all") {
    filter = undefined;
  } else if (workspace !== undefined && workspace !== "") {
    filter = workspace;
  } else {
    filter = detectCursorWorkspace(process.cwd());
  }

  const sessions = [...listSessions({ workspace: filter })].sort((a, b) => {
    const ae = a.endedAt ? 1 : 0;
    const be = b.endedAt ? 1 : 0;
    if (ae !== be) return ae - be;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  const nameCount = new Map<string, number>();
  for (const s of sessions) {
    const n = shortName(s);
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  }

  const titleCount = new Map<string, number>();
  for (const s of sessions) {
    titleCount.set(s.title, (titleCount.get(s.title) ?? 0) + 1);
  }

  const seen = new Set<string>();
  const labels: string[] = [];
  for (const s of sessions) {
    const n = shortName(s);
    let label: string;
    if (n.trim() && nameCount.get(n) === 1) label = n;
    else if (s.title.trim() && titleCount.get(s.title) === 1) label = s.title;
    else label = s.id.slice(0, 8);
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }

  const q = prefix.trim().toLowerCase();
  if (!q) return labels;

  return labels.filter((l) => {
    const lower = l.toLowerCase();
    return lower.startsWith(q) || lower.includes(q);
  });
}

/** Distinct workspace basenames / paths for `complete workspaces`. */
export function workspaceSuggestions(prefix = ""): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of listSessions()) {
    if (!s.workspace) continue;
    const base = s.workspace.split("/").filter(Boolean).pop() || s.workspace;
    for (const label of [base, s.workspace]) {
      if (seen.has(label)) continue;
      seen.add(label);
      out.push(label);
    }
  }
  const q = prefix.trim().toLowerCase();
  if (!q) return out;
  return out.filter((l) => l.toLowerCase().includes(q));
}

const COMMANDS = [
  "hook",
  "view",
  "list",
  "focus",
  "cleanup",
  "config",
  "install-hooks",
  "doctor",
  "completion",
  "complete",
  "help",
] as const;

export function commandSuggestions(prefix = ""): string[] {
  const q = prefix.trim().toLowerCase();
  if (!q) return [...COMMANDS];
  return COMMANDS.filter((c) => c.startsWith(q));
}

export function configKeySuggestions(prefix = ""): string[] {
  const keys = ["autoOpen", "background", "focus", "ttl"];
  const q = prefix.trim().toLowerCase();
  if (!q) return keys;
  return keys.filter((k) => k.toLowerCase().startsWith(q));
}

/** Print newline-separated suggestions (consumed by shell completion scripts). */
export function printComplete(args: string[]): void {
  const [what, ...rest] = args;
  let lines: string[] = [];

  // watchty complete sessions [prefix]
  // watchty complete sessions --workspace <w> [prefix]
  // watchty complete sessions --all [prefix]
  let workspace: string | undefined; // undefined → auto-detect Cursor workspace
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--all" || a === "-a") {
      workspace = "*";
      continue;
    }
    if (a === "--workspace" || a === "-w") {
      workspace = rest[++i] ?? ".";
      continue;
    }
    if (a.startsWith("--workspace=")) {
      workspace = a.slice("--workspace=".length);
      continue;
    }
    positionals.push(a);
  }
  const prefix = positionals[0] ?? "";

  switch (what) {
    case "sessions":
    case "session":
      lines = sessionAttachSuggestions(prefix, workspace);
      break;
    case "workspaces":
    case "workspace":
      lines = workspaceSuggestions(prefix);
      break;
    case "commands":
    case "command":
      lines = commandSuggestions(prefix);
      break;
    case "config-keys":
    case "config":
      lines = configKeySuggestions(prefix);
      break;
    default:
      console.error(
        "usage: watchty complete <sessions|workspaces|commands|config-keys> [prefix]",
      );
      process.exitCode = 1;
      return;
  }
  for (const line of lines) {
    if (line) console.log(line);
  }
}

function detectShell(explicit?: string): "zsh" | "bash" {
  if (explicit === "zsh" || explicit === "bash") return explicit;
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return "zsh";
  return "bash";
}

/**
 * `watchty completion`           → print script for $SHELL
 * `watchty completion zsh|bash`  → print script
 * `watchty completion install`   → write + hook shell rc
 */
export function handleCompletionCommand(args: string[]): void {
  const [first, second] = args;
  if (first === "install") {
    installCompletion(second);
    return;
  }
  if (first && first !== "zsh" && first !== "bash") {
    console.error("usage: watchty completion [zsh|bash|install]");
    process.exitCode = 1;
    return;
  }
  const shell = detectShell(first);
  console.log(shell === "zsh" ? zshScript() : bashScript());
}

function zshScript(): string {
  return `#compdef watchty
# Install: watchty completion install
# Or once: eval "$(watchty completion zsh)"

_watchty() {
  local -a _wty_cmds _wty_sess _wty_keys
  local expl

  _wty_cmds=(
    'hook:Read Cursor hook JSON from stdin'
    'view:Follow a session (omit = latest live)'
    'list:List known sessions'
    'focus:Focus the Ghostty tab for a session'
    'cleanup:Delete old session logs'
    'config:Show or set config'
    'install-hooks:Write ~/.cursor/hooks.json'
    'doctor:Check install / Ghostty / hooks'
    'completion:Print or install shell completion'
    'help:Show help'
  )

  # words[1]=watchty, words[2]=subcommand (no -C; avoids $line vs $words bugs)
  if [[ $CURRENT -eq 2 ]]; then
    _describe -t commands 'command' _wty_cmds
    return 0
  fi

  case \${words[2]} in
    view|focus|list)
      if [[ \${words[CURRENT-1]} == -w || \${words[CURRENT-1]} == --workspace ]]; then
        local -a _wty_ws
        _wty_ws=("\${(@f)\$(watchty complete workspaces 2>/dev/null)}")
        if [[ -n \${_wty_ws[1]} ]]; then
          _wanted workspaces expl 'workspace' compadd -Q -S '' -- "\${_wty_ws[@]}"
        fi
        return 0
      fi
      if [[ \${words[CURRENT]} == -* ]]; then
        _values 'flags' --workspace -w --all -a
        return 0
      fi
      if [[ \${words[2]} == list ]]; then
        _values 'flags' --workspace -w --all -a
        return 0
      fi
      # Sessions for cwd by default (same as CLI)
      _wty_sess=("\${(@f)\$(watchty complete sessions 2>/dev/null)}")
      if [[ -n \${_wty_sess[1]} ]]; then
        _wanted sessions expl 'session' compadd -Q -S '' -- "\${_wty_sess[@]}"
      fi
      return 0
      ;;
    config)
      if [[ $CURRENT -eq 3 ]]; then
        _values 'config' show set get
      elif [[ $CURRENT -eq 4 && \${words[3]} == set ]]; then
        _wty_keys=("\${(@f)\$(watchty complete config-keys 2>/dev/null)}")
        _wanted keys expl 'key' compadd -S '' -- "\${_wty_keys[@]}"
      fi
      return 0
      ;;
    cleanup)
      _values 'flags' --ttl --dry-run -n -t
      return 0
      ;;
    completion)
      _values 'action' zsh bash install
      return 0
      ;;
    install-hooks)
      _values 'flags' --force
      return 0
      ;;
  esac
  return 0
}

compdef _watchty watchty
`;
}

function bashScript(): string {
  return `# Install: watchty completion install
# Or once: eval "$(watchty completion bash)"

_watchty() {
  local cur prev cmd
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"

  # Never fall back to file/folder completion for watchty.
  compopt +o default 2>/dev/null
  compopt +o filenames 2>/dev/null
  compopt -o nospace 2>/dev/null

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    local cmds
    cmds="$(watchty complete commands 2>/dev/null)"
    COMPREPLY=( $(compgen -W "\${cmds}" -- "\${cur}") )
    return 0
  fi

  case "\${cmd}" in
    view|focus|list)
      if [[ "\${prev}" == "-w" || "\${prev}" == "--workspace" ]]; then
        local IFS=$'\\n'
        COMPREPLY=()
        while IFS= read -r line; do
          [[ -z "\${line}" ]] && continue
          COMPREPLY+=("\${line}")
        done < <(watchty complete workspaces "\${cur}" 2>/dev/null)
        return 0
      fi
      if [[ "\${cur}" == -* || "\${cmd}" == list ]]; then
        COMPREPLY=( $(compgen -W "--workspace -w --all -a" -- "\${cur}") )
        if [[ "\${cmd}" == list ]]; then
          return 0
        fi
        # also allow session names if not only flags
        if [[ "\${cur}" == -* ]]; then
          return 0
        fi
      fi
      if [[ "\${cmd}" == list ]]; then
        return 0
      fi
      local IFS=$'\\n'
      local line
      COMPREPLY=()
      while IFS= read -r line; do
        [[ -z "\${line}" ]] && continue
        if [[ -z "\${cur}" || "\${line}" == "\${cur}"* || "\${line}" == *"\${cur}"* ]]; then
          COMPREPLY+=("\${line}")
        fi
      done < <(watchty complete sessions "\${cur}" 2>/dev/null)
      local -a pref other
      pref=()
      other=()
      for line in "\${COMPREPLY[@]}"; do
        if [[ "\${line}" == "\${cur}"* ]]; then
          pref+=("\${line}")
        else
          other+=("\${line}")
        fi
      done
      COMPREPLY=("\${pref[@]}" "\${other[@]}")
      return 0
      ;;
    config)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "show set get" -- "\${cur}") )
      elif [[ \${COMP_CWORD} -eq 3 && \${prev} == set ]]; then
        COMPREPLY=( $(compgen -W "$(watchty complete config-keys 2>/dev/null)" -- "\${cur}") )
      fi
      return 0
      ;;
    cleanup)
      COMPREPLY=( $(compgen -W "--ttl --dry-run -n -t" -- "\${cur}") )
      return 0
      ;;
    completion)
      COMPREPLY=( $(compgen -W "zsh bash install" -- "\${cur}") )
      return 0
      ;;
    install-hooks)
      COMPREPLY=( $(compgen -W "--force" -- "\${cur}") )
      return 0
      ;;
  esac
  return 0
}

complete -F _watchty watchty
`;
}

/** Write completion into ~/.cursor/watchty and hook the user’s shell rc. */
export function installCompletion(shellArg?: string): void {
  const shell = detectShell(shellArg);
  if (shellArg && shellArg !== "zsh" && shellArg !== "bash") {
    console.error("usage: watchty completion install [zsh|bash]");
    process.exitCode = 1;
    return;
  }

  const dir = join(homedir(), ".cursor", "watchty", "completions");
  mkdirSync(dir, { recursive: true });
  const marker = "watchty completion";

  if (shell === "zsh") {
    const file = join(dir, "_watchty");
    writeFileSync(file, zshScript() + "\n", "utf8");
    // Source after compinit so compdef registers (fpath-only is too late if appended).
    const hook = `\n# ${marker}\n[[ -f "${file}" ]] && source "${file}"\n`;
    const rc = join(homedir(), ".zshrc");
    ensureRcHook(rc, marker, hook);
    console.log(`Wrote ${file}`);
    console.log(`Hooked ${rc}`);
    console.log(`Reload: exec zsh   (or: source ~/.zshrc)`);
    console.log(`Then:   watchty view <Tab>`);
    return;
  }

  const file = join(dir, "watchty.bash");
  writeFileSync(file, bashScript() + "\n", "utf8");
  const hook = `\n# ${marker}\n[[ -f "${file}" ]] && source "${file}"\n`;
  const rc = join(homedir(), ".bashrc");
  ensureRcHook(rc, marker, hook);
  console.log(`Wrote ${file}`);
  console.log(`Hooked ${rc}`);
  console.log(`Reload: exec bash   (or: source ~/.bashrc)`);
  console.log(`Then:   watchty view <Tab>`);
}

function ensureRcHook(rcPath: string, marker: string, hook: string): void {
  const existing = existsSync(rcPath) ? readFileSync(rcPath, "utf8") : "";
  if (existing.includes(marker)) {
    console.log(`(rc already contains “${marker}” — left unchanged)`);
    return;
  }
  if (!existsSync(rcPath)) {
    writeFileSync(rcPath, hook.replace(/^\n/, ""), "utf8");
    return;
  }
  appendFileSync(rcPath, hook, "utf8");
}
