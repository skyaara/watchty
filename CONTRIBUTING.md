# Contributing to watchty

Thanks for helping improve watchty — a small tool that **watches** Cursor Agent shell output in Ghostty (or any terminal via pull mode). It does not run an agent.

## Setup

```bash
bun install
bun link
watchty doctor
```

## Development

- Entry point: `src/cli.ts` (via `bin/watchty`)
- Hooks: `src/hook.ts` → events in `~/.cursor/watchty/sessions/*.jsonl`
- Ghostty AppleScript: `src/ghostty.ts`
- Viewer TUI: `src/view.ts`
- Cleanup/TTL: `src/cleanup.ts`

Run the CLI without linking:

```bash
bun src/cli.ts help
bun src/cli.ts doctor
```

## Guidelines

- Keep the product Ghostty-first; pull-mode `view` must keep working in other terminals.
- Prefer small, focused PRs.
- Don’t commit secrets, personal `~/.cursor` state, or local absolute paths.
- Match existing TypeScript style (Bun, no unnecessary abstractions).

## Reporting issues

Include:

- macOS version, Ghostty version (`watchty doctor` output)
- Whether you’re using auto-open or pull mode
- Steps to reproduce

## License

By contributing, you agree your contributions are licensed under the MIT License.
