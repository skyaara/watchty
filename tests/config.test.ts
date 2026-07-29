import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig, resolvedSettings, saveConfig } from "../src/config";
import { resetWatchtyData } from "./helpers";

/**
 * Config defaults and env overrides (README: env wins over config file).
 */
describe("watchty configuration", () => {
  const envKeys = [
    "WATCHTY_AUTO_OPEN",
    "WATCHTY_BACKGROUND",
    "WATCHTY_FOCUS",
    "WATCHTY_TTL",
    "WATCHTY_TTL_HOURS",
    "WATCHTY_HOOKS_SCOPE",
  ] as const;

  beforeEach(() => resetWatchtyData());
  afterEach(() => {
    resetWatchtyData();
    for (const k of envKeys) delete process.env[k];
  });

  test("ships sensible defaults for a fresh install", () => {
    expect(loadConfig()).toEqual({
      autoOpen: true,
      background: true,
      focus: false,
      ttlHours: 168,
      hooksScope: "global",
    });
  });

  test("persists user changes to config.json", () => {
    saveConfig({ autoOpen: false, focus: true, ttlHours: 24 });
    expect(loadConfig()).toMatchObject({
      autoOpen: false,
      focus: true,
      ttlHours: 24,
    });
    expect(loadConfig().background).toBe(true);
  });

  test("environment variables override file config", () => {
    saveConfig({ autoOpen: true, focus: false, ttlHours: 168, hooksScope: "global" });
    process.env.WATCHTY_AUTO_OPEN = "false";
    process.env.WATCHTY_FOCUS = "1";
    process.env.WATCHTY_TTL = "24h";
    process.env.WATCHTY_HOOKS_SCOPE = "workspace";

    expect(resolvedSettings()).toMatchObject({
      autoOpen: false,
      focus: true,
      ttlHours: 24,
      hooksScope: "workspace",
    });
  });

  test("persists hooksScope", () => {
    saveConfig({ hooksScope: "workspace" });
    expect(loadConfig().hooksScope).toBe("workspace");
  });
});
