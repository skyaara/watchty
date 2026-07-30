import { existsSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/paths";

/** Wipe watchty state between tests in this worker. */
export function resetWatchtyData(): void {
  for (const name of [
    "state.json",
    "state.lock",
    "config.json",
    "last-cleanup",
  ]) {
    const p = join(ROOT, name);
    if (existsSync(p)) unlinkSync(p);
    for (const suffix of [".tmp", ".tmp.lock"]) {
      const alt = join(ROOT, name + suffix);
      if (existsSync(alt)) unlinkSync(alt);
    }
  }
  for (const dir of ["sessions", "completions"]) {
    const path = join(ROOT, dir);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      rmSync(join(path, name), { force: true });
    }
  }
}

/** Capture console.log / console.error lines for one callback. */
export function captureConsole(fn: () => void): {
  log: string[];
  error: string[];
} {
  const log: string[] = [];
  const error: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    log.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    error.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { log, error };
}

/** Capture process.stdout.write chunks for one async callback. */
export async function captureStdout(
  fn: () => void | Promise<void>,
): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}
