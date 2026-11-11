/** Per-turn null deliberately clears a thread pin; only omission inherits it. */
export function runCredentialProfileId(
  request: { credentialProfileId?: string | null; threadId?: string | null },
  threadProfileId: (threadId: string) => string | null | undefined,
): string | null {
  return request.credentialProfileId !== undefined
    ? request.credentialProfileId
    : request.threadId
      ? (threadProfileId(request.threadId) ?? null)
      : null;
}
