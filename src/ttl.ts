/** Parse durations like `7d`, `24h`, `90m`, `3600`, or `0` (disabled). Returns ms. */
export function parseTtl(raw: string): number | undefined {
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (s === "0" || s === "off" || s === "never" || s === "false") return 0;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const unit = m[2] ?? "h";
  const mult =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000; // d
  return Math.round(n * mult);
}

export function formatTtl(ms: number): string {
  if (ms <= 0) return "off";
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}
