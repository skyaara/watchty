# watchty

Watch Cursor Agent shell commands in **Ghostty** — a live sidebar of what the agent ran, outside the chat UI.

Commands still execute inside Cursor. watchty only **mirrors** transcripts into Ghostty tabs (or any terminal via pull mode). It is not an agent.

**Ghostty** is the focused auto-open experience. **Any terminal** can attach with `watchty view`.

## Requirements

- macOS (Ghostty auto-open uses AppleScript)
- [Bun](https://bun.sh) ≥ 1.1
- [Ghostty](https://ghostty.org) ≥ 1.3 for auto-open tabs
- Cursor hooks enabled

Pull-only viewing works in iTerm, Terminal.app, Kitty, WezTerm, Alacritty, etc.

## Install

Needs [Bun](https://bun.sh). One-liner (global CLI on PATH — needed so Cursor hooks can find it):

```bash
bun add -g github:skyaara/watchty
watchty install-hooks
watchty doctor
```

Or try without installing:

```bash
bunx github:skyaara/watchty doctor
bunx github:skyaara/watchty help
```

For hooks, prefer `bun add -g` (or `bun link` from a clone) so `~/.cursor/hooks.json` points at a stable binary, not a temporary `bunx` cache path.

From a clone (dev):

```bash
git clone https://github.com/skyaara/watchty.git
cd watchty && bun install && bun link
watchty install-hooks
watchty doctor
```

If you already have hooks, merge entries from [`hooks.example.json`](hooks.example.json), or run `watchty install-hooks --force` to merge watchty into an existing `hooks.json` (other hooks are preserved).

On first Ghostty open from a hook, macOS may ask to allow **Automation** (Cursor → Ghostty). Approve it.

Migrating from an older local install that used `~/.cursor/agent-ghostty`:

```bash
mv ~/.cursor/agent-ghostty ~/.cursor/watchty   # optional; watchty also reads the legacy path
```

## Usage

### Ghostty (default)

Start an Agent chat and submit a prompt. A Ghostty tab opens on the first prompt (not on empty new-chat), without stealing focus by default, and follows:

```text
~/.cursor/watchty/sessions/<conversation_id>.jsonl
```

Defaults:

- `background: true` — don’t activate Ghostty / steal app focus
- `focus: false` — create the tab but **stay on your current Ghostty tab**
- Tab titles use the Cursor chat name (e.g. `repo | Fix login`)

```bash
watchty config set focus true   # jump to new session tabs
```

### Pull mode (any terminal)

Hooks always write the same jsonl. Skip Ghostty auto-open and attach from any terminal:

```bash
watchty config set autoOpen false

watchty list                        # this Cursor workspace (if detected)
watchty list --all                  # every workspace
watchty view                        # latest live session in scope
watchty view "Fix login"            # substring of Cursor chat / tab title
```

`view` polls the jsonl (~120ms) and redraws when it grows. Ghostty-only features (`focus`, `i` / `I` shell splits) are unavailable elsewhere; the output mirror still works.

### Cleanup (TTL)

Session state and transcripts under `~/.cursor/watchty/` are pruned by age.

| | |
|--|--|
| **Default TTL** | `7d` (`ttlHours: 168`) |
| **Age based on** | `endedAt`, else `updatedAt` |
| **Auto** | On `sessionStart` / `sessionEnd`, at most once per hour |
| **Manual** | `watchty cleanup` |
| **Disable auto** | `config set ttl 0` (manual `--ttl` still works) |

Deletes: state entry, `.jsonl`, viewer lock, pending cmd file, legacy `.log`.

```bash
watchty config set ttl 7d
watchty config set ttl 0            # disable auto-cleanup

watchty cleanup                     # configured TTL
watchty cleanup --ttl 24h
watchty cleanup --ttl 3d --dry-run
```

Duration formats: `7d`, `24h`, `90m`, bare number = hours, or `0` / `off`.

### CLI

```bash
watchty list                        # Cursor workspace for cwd (else all)
watchty list -w my-app
watchty list --all
watchty view [title-or-id]
watchty view -w . "Fix login"
watchty focus <title-or-id>         # Ghostty only
watchty cleanup [--ttl <dur>] [--dry-run]
watchty config
watchty config set <key> <value>
watchty install-hooks [--force]
watchty doctor
watchty completion install          # tab-complete session names (zsh/bash)
```

### Workspace filter

`list` / `view` / `focus` / tab-complete **auto-scope** when the current folder is a Cursor workspace:

- recorded in a prior agent session (`workspace_roots`), or
- has a project-local `.cursor/` / `.cursorignore` (not `~/.cursor`)

Subdirectories of that project count too. If you’re outside a Cursor workspace (e.g. `$HOME`), they show **all** sessions.

| Flag | Effect |
|------|--------|
| *(default)* | Cursor workspace for cwd when detected; else all |
| `-w` / `--workspace <name\|path\|.>` | Force that workspace |
| `-a` / `--all` | Every workspace |

### Tab completion

```bash
watchty completion install
exec zsh          # or: source ~/.zshrc
watchty view <Tab>
```

Suggestions follow the same workspace filter as `list`. Complete `-w` values with known workspace names.

## How it works

1. Cursor fires session/shell hooks.
2. Hooks append events to `~/.cursor/watchty/sessions/<id>.jsonl`.
3. **One** Ghostty tab opens per chat on the first prompt (unless `autoOpen` is false).
4. That tab (or `watchty view` in any terminal) runs a small TUI and polls the jsonl.
5. TTL cleanup removes old sessions (auto from hooks, or via `cleanup`).

Viewer keys: `↑/↓` or `j/k` select a command, `u/d` scroll, `f` follow latest, `i` / `I` interactive shell split (**Ghostty only**), `q` / Ctrl-C leave the TUI — auto-opened tabs become a login shell in the same pane; `watchty view` returns to your shell.

## Config

`~/.cursor/watchty/config.json` (hooks read this). Env vars override when set.

| Key / env | Effect |
|-----------|--------|
| `autoOpen` / `WATCHTY_AUTO_OPEN` | Open Ghostty from hooks (default `true`) |
| `background` / `WATCHTY_BACKGROUND` | Don’t call AppleScript `activate` (default `true`; see [known bug](#known-bug-background-still-steals-focus)) |
| `focus` / `WATCHTY_FOCUS` | Switch to the new session tab (default `false`) |
| `ttlHours` / `WATCHTY_TTL` | Auto-delete sessions older than this (default `7d`; `0` = off) |

```bash
watchty config set autoOpen false
watchty config set ttl 3d
watchty config show
```

```json
{
  "autoOpen": true,
  "background": true,
  "focus": false,
  "ttlHours": 168
}
```

## Privacy

Hooks can see shell **commands and captured output** from Cursor Agent. watchty writes that data to your machine only:

```text
~/.cursor/watchty/
```

Nothing is uploaded. Treat that directory like any other local log of terminal activity. Use TTL cleanup (or `watchty cleanup`) to limit retention. Do not commit or share session `.jsonl` files — they may contain secrets from command output.

## Known bug: `background` still steals focus

**With `background: true` (the default), Ghostty can still jump to the front** when a session tab opens — even though watchty deliberately skips AppleScript `activate`.

Cause: Ghostty’s AppleScript `new tab` / `new window` handlers activate the app themselves (`NSApp.activate`). That is upstream, not a watchty config miss. Tracked in [ghostty-org/ghostty#11457](https://github.com/ghostty-org/ghostty/issues/11457); watchty follow-up: [#1](https://github.com/skyaara/watchty/issues/1).

Workarounds until Ghostty ships a fix:

- Leave Ghostty open already (less disruptive than a cold `new window`, but a new tab may still steal focus)
- Or disable auto-open and attach when you want: `watchty config set autoOpen false`, then `watchty view`

## Troubleshooting

- Auto-open steals focus despite `background: true` → known Ghostty bug above; not fixed by flipping config
- `doctor` reports Ghostty AppleScript failure → install Ghostty 1.3+, ensure `macos-applescript` is not disabled, grant Automation. Pull mode (`view`) still works without Ghostty.
- No tabs but logs exist → `watchty view` in any terminal.
- Binary not found from hooks → `bun link` and confirm `which watchty`.
- Disk filling up → `watchty config set ttl 24h` or `watchty cleanup --dry-run`.
- Tab completes folders instead of sessions → `watchty completion install` then `source ~/.zshrc`.
- `list` shows every project → you’re outside a Cursor workspace; use `-w .` or `cd` into the project.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
