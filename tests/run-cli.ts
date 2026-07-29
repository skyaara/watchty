import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

/** Spawn the CLI in a fresh process (env applies before module load). */
export async function runCli(
  args: string[],
  opts: {
    env?: Record<string, string | undefined>;
    stdin?: string;
    cwd?: string;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dataRoot = opts.env?.WATCHTY_ROOT ?? process.env.WATCHTY_ROOT!;

  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    ),
    WATCHTY_ROOT: dataRoot,
    WATCHTY_AUTO_OPEN: "false",
    ...Object.fromEntries(
      Object.entries(opts.env ?? {}).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    ),
  };

  const proc = Bun.spawn({
    cmd: [process.execPath, join(REPO_ROOT, "src/cli.ts"), ...args],
    cwd: opts.cwd ?? REPO_ROOT,
    env,
    stdin: opts.stdin ? new Blob([opts.stdin]) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { code, stdout, stderr };
}
