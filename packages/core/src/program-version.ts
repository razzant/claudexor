import type { HarnessProgram } from "@claudexor/schema";

/** Is the observed published pointer newer? Never order an unknown version scheme. */
export function programUpdateAvailable(
  scheme: HarnessProgram["versionScheme"],
  selected: string | null,
  newest: string | null,
): "yes" | "no" | "cannot_tell" {
  if (!selected || !newest) return "cannot_tell";
  if (selected === newest) return "no";
  if (scheme === "date-hash") {
    const parse = (s: string) => {
      const m = /^(\d{4})\.(\d{2})\.(\d{2})-([a-zA-Z0-9]+)$/.exec(s);
      if (!m) return null;
      const date = `${m[1]}-${m[2]}-${m[3]}`;
      const ms = Date.parse(date);
      return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? date : null;
    };
    const a = parse(selected),
      b = parse(newest);
    // Hashes identify builds but do not order builds on the same day.
    return !a || !b || a === b ? "cannot_tell" : b > a ? "yes" : "no";
  }
  if (scheme !== "semver") return "cannot_tell";
  const parse = (s: string) => {
    const m =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
        s,
      );
    if (!m || m[4]?.split(".").some((v) => /^0\d+$/.test(v))) return null;
    return { numbers: m.slice(1, 4).map(BigInt), pre: m[4]?.split(".") ?? [] };
  };
  const a = parse(selected),
    b = parse(newest);
  if (!a || !b) return "cannot_tell";
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i]) return b.numbers[i]! > a.numbers[i]! ? "yes" : "no";
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length && !b.pre.length ? "yes" : "no";
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i],
      y = b.pre[i];
    if (x === y) continue;
    if (x === undefined) return "yes";
    if (y === undefined) return "no";
    const nx = /^\d+$/.test(x),
      ny = /^\d+$/.test(y);
    if (nx !== ny) return nx ? "yes" : "no";
    return (nx ? BigInt(y) > BigInt(x) : y > x) ? "yes" : "no";
  }
  return "no";
}
