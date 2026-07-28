import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATH, loadConfig } from "./config";
import { formatTtl } from "./cleanup";
import { ghosttyAvailable } from "./ghostty";
import { packageRoot, selfBin } from "./hook";
import { ROOT, STATE_PATH, SESSIONS_DIR } from "./paths";

export async function cmdDoctor(): Promise<void> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  const bunPath = Bun.which("bun");
  checks.push({
    name: "bun",
    ok: Boolean(bunPath),
    detail: bunPath ?? "bun not on PATH",
  });

  const bin = selfBin();
  checks.push({
    name: "cli",
    ok: true,
    detail: bin,
  });

  const linked = Bun.which("watchty");
  checks.push({
    name: "PATH binary",
    ok: Boolean(linked),
    detail: linked
      ? linked
      : `not linked — run: cd ${packageRoot()} && bun link`,
  });

  const g = ghosttyAvailable();
  checks.push({ name: "Ghostty AppleScript", ok: g.ok, detail: g.detail });

  const hooksPath = join(homedir(), ".cursor", "hooks.json");
  let hooksOk = false;
  let hooksDetail = `${hooksPath} missing — run: watchty install-hooks`;
  if (existsSync(hooksPath)) {
    try {
      const raw = readFileSync(hooksPath, "utf8");
      hooksOk = raw.includes("watchty");
      hooksDetail = hooksOk
        ? `wired in ${hooksPath}`
        : `${hooksPath} exists but does not mention watchty — run install-hooks --force or merge`;
    } catch (e) {
      hooksDetail = String(e);
    }
  }
  checks.push({ name: "hooks.json", ok: hooksOk, detail: hooksDetail });

  const cfg = loadConfig();
  checks.push({
    name: "config",
    ok: true,
    detail: `${CONFIG_PATH} autoOpen=${cfg.autoOpen} background=${cfg.background} focus=${cfg.focus} ttl=${formatTtl(Math.round(cfg.ttlHours * 3_600_000))}`,
  });

  checks.push({
    name: "data dir",
    ok: true,
    detail: `${ROOT} (state: ${STATE_PATH}, logs: ${SESSIONS_DIR})`,
  });

  let failed = false;
  for (const c of checks) {
    const mark = c.ok ? "ok" : "!!";
    console.log(`[${mark}] ${c.name}: ${c.detail}`);
    if (!c.ok) failed = true;
  }

  if (!g.ok) {
    console.log(
      "\nHint: System Settings → Privacy & Security → Automation — allow the app running hooks (Cursor) to control Ghostty.",
    );
  }
  if (!linked) {
    console.log(`\nInstall: cd ${packageRoot()} && bun link`);
  }

  console.log(`\nExample: watchty view "Fix login"`);
  if (failed) process.exitCode = 1;
}
