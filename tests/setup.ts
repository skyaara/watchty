import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Isolated data dir per test worker — set before any src module loads. */
process.env.WATCHTY_ROOT = mkdtempSync(join(tmpdir(), "watchty-test-"));
