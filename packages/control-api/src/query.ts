export function assertOnlyQueryParams(url: URL, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allow.has(key)) throw new Error(`unsupported query parameter: ${key}`);
  }
}

export function optionalBooleanQuery(url: URL, name: string): boolean | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1 || (values[0] !== undefined && !["true", "false"].includes(values[0]))) {
    throw new Error(`${name} must be exactly true or false`);
  }
  return values[0] === undefined ? undefined : values[0] === "true";
}
