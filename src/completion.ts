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
 * Most recently updated sessions are listed first (endedAt is not a filter).
 *
 * Default scope: current Cursor workspace when detectable; else all.
 * Pass workspace=`*` / `all` for everything; or an explicit path/name.
 */
function sessionAttachSuggestions(
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

  // listSessions already sorts by updatedAt desc; copy for stable labeling.
  const sessions = listSessions({ workspace: filter });

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

  // Keep trailing spaces (multi-word Tab after a shared first word).
  const q = prefix.toLowerCase();
  if (!q.trim()) return labels;

  const pref: string[] = [];
  const other: string[] = [];
  for (const l of labels) {
    const lower = l.toLowerCase();
    if (lower.startsWith(q)) pref.push(l);
    else if (lower.includes(q.trim())) other.push(l);
  }
  return [...pref, ...other];
}

/** Distinct workspace basenames / paths for `complete workspaces`. */
function workspaceSuggestions(prefix = ""): string[] {
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

function commandSuggestions(prefix = ""): string[] {
  const q = prefix.trim().toLowerCase();
  if (!q) return [...COMMANDS];
  return COMMANDS.filter((c) => c.startsWith(q));
}

function configKeySuggestions(prefix = ""): string[] {
  const keys = ["autoOpen", "background", "focus", "ttl", "hooksScope"];
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
  const prefix = positionals.join(" ");

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
  // _describe … -Q: plain names with spaces (zsh freenode / SO #54478449).
  // Menu when ambiguous; CLI joins argv so unquoted titles work.
  return `#compdef watchty
# Install: watchty completion install
# Or once: eval "$(watchty completion zsh)"

_watchty() {
  local -a _wty_cmds _wty_sess _wty_keys _wty_ws

  _wty_cmds=(
    'hook:Read Cursor hook JSON from stdin'
    'view:Follow a session (omit = latest live)'
    'list:List known sessions'
    'focus:Focus the Ghostty tab for a session'
    'cleanup:Delete old session logs'
    'config:Show or set config'
    'install-hooks:Write ~/.cursor or project .cursor/hooks.json'
    'doctor:Check install / Ghostty / hooks'
    'completion:Print or install shell completion'
    'help:Show help'
  )

  if [[ $CURRENT -eq 2 ]]; then
    _describe -t commands 'command' _wty_cmds
    return 0
  fi

  case \${words[2]} in
    view|focus|list)
      if [[ \${words[CURRENT-1]} == -w || \${words[CURRENT-1]} == --workspace ]]; then
        _wty_ws=("\${(@f)\$(watchty complete workspaces "\${words[CURRENT]}" 2>/dev/null)}")
        (( \${#_wty_ws[@]} )) && _describe -t workspaces 'workspace' _wty_ws -Q
        return 0
      fi
      if [[ \${words[CURRENT]} == -* || \${words[2]} == list ]]; then
        _values 'flags' --workspace -w --all -a
        return 0
      fi

      # First positional after flags; keep later words as part of the title query.
      local start=3 j q=""
      while (( start <= CURRENT )); do
        case \${words[start]} in
          -w|--workspace) (( start += 2 ));;
          --workspace=*) (( start += 1 ));;
          -a|--all) (( start += 1 ));;
          -*) (( start += 1 ));;
          *) break;;
        esac
      done

      local -a cargs=(complete sessions)
      for (( j = 3; j < start; j++ )); do
        case \${words[j]} in
          -a|--all) cargs+=(--all);;
          -w|--workspace)
            (( j + 1 <= $#words )) && cargs+=(--workspace "\${words[j+1]}")
            (( j++ ))
            ;;
          --workspace=*) cargs+=("\${words[j]}");;
        esac
      done

      if (( start <= CURRENT )); then
        q="\${(j: :)words[start,CURRENT]}"
      fi
      if (( start < CURRENT )); then
        words[start]="\$q"
        words[start+1,-1]=()
        CURRENT=\$start
      fi

      _wty_sess=("\${(@f)\$(watchty "\${cargs[@]}" "\$q" 2>/dev/null)}")
      (( \${#_wty_sess[@]} )) || return 0
      # Ambiguous → menu-complete full titles (never insert shared "Explore ").
      (( \${#_wty_sess[@]} > 1 )) && compstate[insert]=menu
      _describe -t sessions 'session' _wty_sess -Q -U
      return 0
      ;;
    config)
      if [[ $CURRENT -eq 3 ]]; then
        _values 'config' show set get
      elif [[ $CURRENT -eq 4 && \${words[3]} == set ]]; then
        _wty_keys=("\${(@f)\$(watchty complete config-keys 2>/dev/null)}")
        _describe -t keys 'key' _wty_keys
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
      _values 'flags' --global -g --workspace -w --local
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

  compopt +o default 2>/dev/null
  compopt +o filenames 2>/dev/null
  # Keep going after a shared first word; CLI joins argv for the title.
  compopt -o nospace 2>/dev/null

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$(watchty complete commands 2>/dev/null)" -- "\${cur}") )
    return 0
  fi

  case "\${cmd}" in
    view|focus|list)
      if [[ "\${prev}" == "-w" || "\${prev}" == "--workspace" ]]; then
        local IFS=$'\\n' line
        COMPREPLY=()
        while IFS= read -r line; do
          [[ -n "\${line}" ]] && COMPREPLY+=("\${line}")
        done < <(watchty complete workspaces "\${cur}" 2>/dev/null)
        return 0
      fi
      if [[ "\${cur}" == -* || "\${cmd}" == list ]]; then
        COMPREPLY=( $(compgen -W "--workspace -w --all -a" -- "\${cur}") )
        return 0
      fi

      local start=2 i
      for (( i = 2; i <= COMP_CWORD; i++ )); do
        case "\${COMP_WORDS[i]}" in
          -w|--workspace) (( i++ )); continue;;
          --workspace=*) continue;;
          -a|--all) continue;;
          -*) continue;;
          *) start=\$i; break;;
        esac
      done

      local -a cargs=(complete sessions) parts
      for (( i = 2; i < start; i++ )); do
        case "\${COMP_WORDS[i]}" in
          -a|--all) cargs+=(--all);;
          -w|--workspace)
            (( i + 1 < \${#COMP_WORDS[@]} )) && cargs+=(--workspace "\${COMP_WORDS[i+1]}")
            (( i++ ))
            ;;
          --workspace=*) cargs+=("\${COMP_WORDS[i]}");;
        esac
      done

      parts=()
      (( start <= COMP_CWORD )) && parts=("\${COMP_WORDS[@]:start:COMP_CWORD-start+1}")
      local IFS=' '
      cur="\${parts[*]}"
      IFS=$'\\n'

      local line
      COMPREPLY=()
      while IFS= read -r line; do
        [[ -n "\${line}" ]] && COMPREPLY+=("\${line}")
      done < <(watchty "\${cargs[@]}" "\${cur}" 2>/dev/null)
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
      COMPREPLY=( $(compgen -W "--global -g --workspace -w --local" -- "\${cur}") )
      return 0
      ;;
  esac
  return 0
}

complete -o nospace -F _watchty watchty
`;
}

/** Write completion into ~/.cursor/watchty and hook the user’s shell rc. */
function installCompletion(shellArg?: string): void {
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
