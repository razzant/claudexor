/** Return only the effective numeric heap flag, never unrelated environment values.
 * Node command-line singleton flags override NODE_OPTIONS; the last value wins. */
export function effectiveNodeHeapArgs(execArgv: readonly string[], nodeOptions?: string): string[] {
  const extract = (text: string): string | undefined =>
    Array.from(
      text.matchAll(/(?:^|\s)"?--max[-_]old[-_]space[-_]size(?:=|\s+)"?(\d+)"?(?=\s|$)/g),
    ).at(-1)?.[1];
  const value = extract(execArgv.join(" ")) ?? extract(nodeOptions ?? "");
  return value === undefined ? [] : [`--max-old-space-size=${value}`];
}
