import { realpath } from "node:fs/promises";

const repositoryMutationTails = new Map<string, Promise<void>>();

/** One mutation of a target repository at a time, in this process, by its real path. */
export async function withRepositoryMutationLease<T>(
  repoRoot: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = await realpath(repoRoot);
  const previous = repositoryMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.catch(() => undefined).then(() => held);
  repositoryMutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (repositoryMutationTails.get(key) === tail) repositoryMutationTails.delete(key);
  }
}
