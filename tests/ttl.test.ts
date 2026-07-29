import { describe, expect, test } from "bun:test";
import { formatTtl, parseTtl } from "../src/ttl";

/**
 * Users configure session retention via CLI (`watchty config set ttl 7d`)
 * and cleanup flags (`--ttl 24h`). Durations must parse predictably.
 */
describe("session retention durations", () => {
  test("accepts day/hour/minute/second suffixes from user input", () => {
    expect(parseTtl("7d")).toBe(7 * 86_400_000);
    expect(parseTtl("24h")).toBe(24 * 3_600_000);
    expect(parseTtl("90m")).toBe(90 * 60_000);
    expect(parseTtl("30s")).toBe(30_000);
  });

  test("treats bare numbers as hours (config shorthand)", () => {
    expect(parseTtl("168")).toBe(168 * 3_600_000);
    expect(parseTtl("1")).toBe(3_600_000);
  });

  test("disabling retention accepts common off/zero spellings", () => {
    for (const off of ["0", "off", "never", "false", "OFF", " 0 "]) {
      expect(parseTtl(off)).toBe(0);
    }
  });

  test("rejects garbage input instead of guessing", () => {
    expect(parseTtl("")).toBeUndefined();
    expect(parseTtl("   ")).toBeUndefined();
    expect(parseTtl("seven days")).toBeUndefined();
    expect(parseTtl("-1h")).toBeUndefined();
  });

  test("formats durations for human-readable cleanup output", () => {
    expect(formatTtl(0)).toBe("off");
    expect(formatTtl(7 * 86_400_000)).toBe("7d");
    expect(formatTtl(25 * 3_600_000)).toBe("25h");
    expect(formatTtl(90 * 60_000)).toBe("90m");
    expect(formatTtl(45_000)).toBe("45s");
  });
});
