/**
 * Path-confinement guards for run-artifact reads: every artifact fetch must
 * resolve INSIDE the run/artifact root, symlinks are refused (a symlinked
 * artifact could read arbitrary host files into an HTTP response), and `..`
 * traversal is structurally impossible.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";

export function safeArtifactPath(root: string, requested: string): string | null {
  if (requested.includes("\0")) return null;
  const parts = requested.split(/[\\/]+/).filter(Boolean);
  if (parts.includes("..")) return null;
  const base = safeArtifactRoot(root);
  if (!base) return null;
  const clean = normalize(parts.join(sep));
  const abs = resolve(base, clean);
  if (!existsSync(abs)) return null;
  const lst = lstatSync(abs);
  if (lst.isSymbolicLink()) return null;
  const real = realpathSync(abs);
  return real === base || real.startsWith(base + sep) ? real : null;
}

export function safeArtifactRoot(root: string): string | null {
  if (!root || !existsSync(root)) return null;
  const st = lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory()) return null;
  return realpathSync(root);
}
