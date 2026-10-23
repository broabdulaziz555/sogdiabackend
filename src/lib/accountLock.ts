/**
 * Serialises work per account inside this process, so two orders fired back-to-back (one-click trading)
 * cannot both pass the free-margin check against the same balance. Different accounts never wait on each other.
 */
const tails = new Map<string, Promise<void>>();
/** When work last finished on each account (pruned), so a caller that read early can tell whether its reads are still current. */
const lastDone = new Map<string, number>();

/** True when another job is running or queued for this account right now. Exact when called in the same tick as withAccountLock. */
export const isAccountBusy = (accountId: string) => tails.has(accountId);
/** True when a job finished on this account after `t` (ms epoch). */
export const finishedSince = (accountId: string, t: number) => (lastDone.get(accountId) ?? 0) >= t;

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
    const now = Date.now();
    lastDone.set(accountId, now);
    if (lastDone.size > 2000) for (const [k, v] of lastDone) if (now - v > 60_000) lastDone.delete(k);
    release();
    if (tails.get(accountId) === tail) tails.delete(accountId);
  }
}
