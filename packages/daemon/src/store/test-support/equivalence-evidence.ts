import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

export interface InventoryFile {
  path: string;
  size: number;
  sha256: string;
  kind: "file" | "symlink";
}
export function inventory(root: string): InventoryFile[] {
  const rows: InventoryFile[] = [];
  if (!existsSync(root)) return rows;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name),
        stat = lstatSync(path);
      if (stat.isSymbolicLink())
        rows.push({
          path: relative(root, path),
          kind: "symlink",
          size: stat.size,
          sha256: hash(readlinkSync(path)),
        });
      else if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        const fd = openSync(path, "r"),
          bytes = Buffer.alloc(4 * 1024 * 1024),
          digest = createHash("sha256");
        try {
          for (;;) {
            const n = readSync(fd, bytes, 0, bytes.length, null);
            if (!n) break;
            digest.update(bytes.subarray(0, n));
          }
        } finally {
          closeSync(fd);
        }
        rows.push({
          path: relative(root, path),
          kind: "file",
          size: stat.size,
          sha256: digest.digest("hex"),
        });
      } else throw new Error(`unsupported fixture entry: ${relative(root, path)}`);
    }
  };
  walk(root);
  return rows;
}
export function copyInput(source: string, destination: string): void {
  if (existsSync(destination)) throw new Error("qualification copy already exists");
  cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
  // Node's recursive copy can create the destination root with the process
  // umask instead of the source mode; read-only journal preparation checks it.
  const modes = (from: string, to: string) => {
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) return;
    chmodSync(to, stat.mode & 0o777);
    if (stat.isDirectory())
      for (const name of readdirSync(from)) modes(join(from, name), join(to, name));
  };
  modes(source, destination);
}
export function copyResources(source: string | undefined, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of ["resources", "uploads", "blobs", "idempotency"]) {
    const from = source && join(source, name);
    if (from && existsSync(from)) copyInput(from, join(destination, name));
  }
}
export function resourceInventory(source?: string): Record<string, InventoryFile[]> {
  return Object.fromEntries(
    ["resources", "uploads", "blobs", "idempotency"].map((name) => [
      name,
      source ? inventory(join(source, name)) : [],
    ]),
  );
}
export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
export function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function diagnosticHash(value: unknown): string {
  // This is diagnostic evidence only. Equality is always isDeepStrictEqual;
  // the hash never normalizes fields to decide whether a comparison passed.
  const digest = createHash("sha256");
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== "object") {
      digest.update(`${typeof item}:${String(item)}\0`);
      return;
    }
    if (item instanceof Map) {
      digest.update("map[");
      for (const [key, value] of item) {
        visit(key);
        visit(value);
      }
    } else if (item instanceof Set) {
      digest.update("set[");
      for (const value of item) visit(value);
    } else if (Array.isArray(item)) {
      digest.update("array[");
      for (const value of item) visit(value);
    } else {
      digest.update("object[");
      for (const key of Object.keys(item).sort()) {
        visit(key);
        visit((item as Record<string, unknown>)[key]);
      }
    }
    digest.update("]");
  };
  visit(value);
  return digest.digest("hex");
}
function difference(a: unknown, b: unknown, path = "$", depth = 0): string {
  if (isDeepStrictEqual(a, b)) return path;
  if (depth >= 12 || !a || !b || typeof a !== "object" || typeof b !== "object") return path;
  if (a instanceof Map && b instanceof Map) {
    for (const [key, value] of a)
      if (!b.has(key) || !isDeepStrictEqual(value, b.get(key)))
        return difference(value, b.get(key), `${path}.map[${String(key)}]`, depth + 1);
    return `${path}.map.keys`;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = (a as Record<string, unknown>)[key],
      y = (b as Record<string, unknown>)[key];
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key) || !isDeepStrictEqual(x, y))
      return difference(x, y, `${path}.${key}`, depth + 1);
  }
  return path;
}
export class Comparisons {
  checked = 0;
  readonly failures: Array<{
    label: string;
    path?: string;
    expectedSha256?: string;
    actualSha256?: string;
    problem?: string;
    code?: string;
    status?: number;
    retryable?: boolean;
  }> = [];
  readonly counts: Record<string, number> = {};
  constructor(private readonly output: string) {}
  equal(label: string, expected: unknown, actual: unknown): boolean {
    this.checked++;
    const family = label.split(":")[0]!;
    this.counts[family] = (this.counts[family] ?? 0) + 1;
    if (isDeepStrictEqual(expected, actual)) return true;
    const row = {
      label,
      path: difference(expected, actual),
      expectedSha256: diagnosticHash(expected),
      actualSha256: diagnosticHash(actual),
    };
    this.failures.push(row);
    this.save();
    console.log(JSON.stringify({ mismatch: row }));
    return false;
  }
  problem(label: string, error: unknown): void {
    const typed = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
    const row = {
      label,
      problem: error instanceof Error ? error.name : typeof error,
      ...(typeof typed.code === "string" ? { code: typed.code } : {}),
      ...(typeof typed.status === "number" ? { status: typed.status } : {}),
      ...(typeof typed.retryable === "boolean" ? { retryable: typed.retryable } : {}),
    };
    this.failures.push(row);
    this.save();
    console.log(JSON.stringify({ mismatch: row }));
  }
  save(): void {
    writeJson(join(this.output, "comparisons.json"), {
      checked: this.checked,
      counts: this.counts,
      failures: this.failures,
    });
  }
}
export function privateMap(value: object, name: string): Map<string, unknown> {
  const map = Reflect.get(value, name);
  if (!(map instanceof Map)) throw new Error(`frozen projection no longer exposes ${name}`);
  return map;
}
