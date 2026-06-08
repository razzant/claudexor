import { join, relative, sep } from "node:path";
import { readTextSafe } from "@claudexor/util";

export interface AgentsDoc {
  path: string;
  content: string;
}

/**
 * Discover AGENTS.md files from the repo root down to `startDir` (closest wins).
 * Per directory, `AGENTS.override.md` beats `AGENTS.md`. Returns root-first order
 * so concatenation lets deeper files override earlier guidance.
 */
export function discoverAgentsFiles(repoRoot: string, startDir?: string): AgentsDoc[] {
  const start = startDir ?? repoRoot;
  const rel = relative(repoRoot, start);
  const segments = rel && !rel.startsWith("..") ? rel.split(sep).filter(Boolean) : [];

  const dirs = [repoRoot];
  let dir = repoRoot;
  for (const seg of segments) {
    dir = join(dir, seg);
    dirs.push(dir);
  }

  const docs: AgentsDoc[] = [];
  for (const d of dirs) {
    for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
      const content = readTextSafe(join(d, name));
      if (content !== null && content.trim().length > 0) {
        docs.push({ path: join(d, name), content });
        break;
      }
    }
  }
  return docs;
}

export function loadAgentsInstructions(
  repoRoot: string,
  startDir?: string,
): { text: string; sources: string[] } {
  const docs = discoverAgentsFiles(repoRoot, startDir);
  return {
    text: docs.map((d) => d.content.trim()).join("\n\n---\n\n"),
    sources: docs.map((d) => d.path),
  };
}
