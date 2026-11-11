/** Text sections of a GitHub workflow for the release workflow checker and the
 * tests that execute its steps. Accept LF/CRLF checkouts; return LF sections.
 * Pure: usable on mutated workflow copies. */

/** One job, from its key to the next job key. */
export function jobSection(workflow, name) {
  workflow = workflow.replace(/\r\n/g, "\n");
  const start = workflow.indexOf(`  ${name}:\n`);
  if (start < 0) return "";
  const next = workflow.slice(start + 2).search(/^  [a-z0-9-]+:\n/m);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 2 + next);
}

/** One named step. It ends before the next step item at the same indentation,
 * named or not, so a requirement scoped to this step cannot be met by a
 * neighboring `- run:` or `- uses:` step. */
export function stepBody(job, name) {
  job = job.replace(/\r\n/g, "\n");
  const marker = `      - name: ${name}\n`;
  const start = job.indexOf(marker);
  if (start < 0) return "";
  const next = job.slice(start + marker.length).search(/^      - /m);
  return next < 0 ? job.slice(start) : job.slice(start, start + marker.length + next);
}

/** A step's literal `run: |` block as the runner receives it: the block
 * indentation removed and trailing line breaks dropped. Empty when absent. */
export function stepRunScript(step) {
  const lines = step.replace(/\r\n/g, "\n").split("\n");
  const header = lines.findIndex((line) => /^ *run: \|$/.test(line));
  if (header < 0) return "";
  const keyIndent = lines[header].search(/\S/);
  const block = [];
  for (const line of lines.slice(header + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= keyIndent) break;
    block.push(line);
  }
  const indent = Math.min(
    ...block.filter((line) => line.trim() !== "").map((line) => line.search(/\S/)),
  );
  return block
    .map((line) => line.slice(indent))
    .join("\n")
    .replace(/\n+$/, "");
}
