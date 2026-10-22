/**
 * Serialises work per account inside this process, so two orders fired back-to-back (one-click trading)
 * cannot both pass the free-margin check against the same balance. Different accounts never wait on each other.
 */
const tails = new Map<string, Promise<void>>();

export async function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(accountId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = prev.then(() => mine);
  tails.set(accountId, tail);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(accountId) === tail) tails.delete(accountId);
  }
}
