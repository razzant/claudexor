export function assertOnlyQueryParams(url: URL, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allow.has(key)) throw new Error(`unsupported query parameter: ${key}`);
  }
}

export function optionalBooleanQuery(url: URL, name: string): boolean | undefined {
  const value = singleQuery(url, name);
  if (value !== undefined && !["true", "false"].includes(value)) {
    throw new Error(`${name} must be exactly true or false`);
  }
  return value === undefined ? undefined : value === "true";
}

export function singleQuery(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new Error(`${name} may be specified only once`);
  return values[0];
}
