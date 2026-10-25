/**
 * Messages whose components a live collector is answering right now.
 *
 * `runComponentPanel` and `awaitConfirmation` register the message they sent
 * for as long as their collector runs. The interaction router leaves clicks
 * on these messages alone - the collector answers them - and steps in only
 * for components nothing is listening to any more (after a restart, or once a
 * panel's collector has ended), so a user never sees Discord's bare
 * "This interaction failed".
 *
 * A message is also remembered for `SETTLED_COMPONENT_MEMORY_MS` after its
 * last collector ended. Its owner is replacing it with the next state right
 * then (a confirmed action's progress, a closed panel), so a late second
 * click is acknowledged quietly instead of being answered with the stale
 * buttons and an "expired, run it again" note.
 */

/** How long a message counts as just settled after its collector ended. */
export const SETTLED_COMPONENT_MEMORY_MS = 10_000;

export interface LiveComponentEntry {
  /** Stop the collector; its `end` handler then disables the components. */
  stop?: (reason: string) => void;
  /** Settles once the `end` handler has finished updating the message. */
  ended?: Promise<unknown>;
}

const live = new Map<string, Set<LiveComponentEntry>>();
/** Message id -> when its last collector ended, oldest first. */
const settled = new Map<string, number>();

function forgetSettledBefore(cutoff: number): void {
  for (const [messageId, at] of settled) {
    if (at > cutoff) break;
    settled.delete(messageId);
  }
}

function markSettled(messageId: string): void {
  const now = Date.now();
  forgetSettledBefore(now - SETTLED_COMPONENT_MEMORY_MS);
  settled.delete(messageId);
  settled.set(messageId, now);
}

/**
 * Mark a message as answered by a live collector.
 * @returns a function that unmarks it; call it when the collector ends
 */
export function trackLiveComponents(
  messageId: string,
  entry: LiveComponentEntry = {}
): () => void {
  let entries = live.get(messageId);
  if (!entries) {
    entries = new Set();
    live.set(messageId, entries);
  }
  entries.add(entry);
  settled.delete(messageId);

  return () => {
    const current = live.get(messageId);
    if (!current?.delete(entry)) return;
    if (current.size === 0) {
      live.delete(messageId);
      markSettled(messageId);
    }
  };
}

/** Whether a collector is still answering this message's components. */
export function isLiveComponentMessage(messageId: string): boolean {
  return (live.get(messageId)?.size ?? 0) > 0;
}

/**
 * Whether this message's last collector ended within the last
 * `SETTLED_COMPONENT_MEMORY_MS`, so its owner is updating it right now.
 */
export function isSettledComponentMessage(
  messageId: string,
  now: number = Date.now()
): boolean {
  const at = settled.get(messageId);
  return at !== undefined && now - at < SETTLED_COMPONENT_MEMORY_MS;
}

/** How many messages currently have a live collector. */
export function liveComponentCount(): number {
  return live.size;
}

/**
 * Stop every live collector (shutdown) and wait - at most `timeoutMs` - for
 * them to disable their components, so panels do not stay clickable on a
 * message no process will answer.
 */
export async function stopLiveComponents(options: {
  timeoutMs: number;
  reason?: string;
}): Promise<void> {
  const reason = options.reason ?? 'shutdown';
  const entries = [...live.values()].flatMap((set) => [...set]);
  const pending: Promise<unknown>[] = [];

  for (const entry of entries) {
    try {
      entry.stop?.(reason);
    } catch {
      // A collector that cannot be stopped is simply left to expire.
    }
    if (entry.ended) pending.push(entry.ended);
  }

  if (pending.length === 0) return;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, options.timeoutMs);
    timer.unref?.();
  });

  try {
    await Promise.race([Promise.allSettled(pending), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Forget every tracked and settled message (tests). */
export function clearLiveComponents(): void {
  live.clear();
  settled.clear();
}
