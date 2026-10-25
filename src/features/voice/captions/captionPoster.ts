/**
 * Posts caption lines to one text channel without tripping Discord's
 * per-channel rate limit (about five messages per five seconds).
 *
 * Lines that arrive while the channel is cooling down are combined into the
 * next message instead of being sent one by one, so a lively conversation
 * becomes a steady trickle of multi-line messages rather than a burst that
 * Discord throttles. If the channel stays unreachable, the oldest lines are
 * dropped: captions that arrive minutes late help nobody.
 */

export interface CaptionPosterOptions {
  /** Minimum gap between two messages (ms). */
  minIntervalMs: number;
  /** Longest message body; Discord's limit is 2000. */
  maxChars: number;
  /** Most lines kept waiting; older ones are dropped. */
  maxPending: number;
}

export const DEFAULT_POSTER_OPTIONS: CaptionPosterOptions = {
  minIntervalMs: 1_200,
  maxChars: 1_900,
  maxPending: 30,
};

export class CaptionPoster {
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = -Infinity;
  private sending = false;
  private stopped = false;

  constructor(
    private readonly send: (content: string) => Promise<void>,
    private readonly options: CaptionPosterOptions = DEFAULT_POSTER_OPTIONS,
    private readonly now: () => number = Date.now
  ) {}

  /** Queue one already-formatted line. */
  add(line: string): void {
    if (this.stopped) return;
    const limit = this.options.maxChars;
    this.pending.push(
      line.length > limit ? `${line.slice(0, limit - 1)}…` : line
    );
    if (this.pending.length > this.options.maxPending) {
      this.pending.splice(0, this.pending.length - this.options.maxPending);
    }
    this.schedule();
  }

  /** Drop everything still waiting and send nothing more. */
  stop(): void {
    this.stopped = true;
    this.pending = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer || this.sending || this.pending.length === 0) return;
    const wait = Math.max(
      0,
      this.lastSentAt + this.options.minIntervalMs - this.now()
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.pending.length === 0) return;

    // As many whole lines as fit; the rest wait for the next message.
    let body = this.pending[0];
    let taken = 1;
    while (
      taken < this.pending.length &&
      body.length + 1 + this.pending[taken].length <= this.options.maxChars
    ) {
      body += `\n${this.pending[taken]}`;
      taken++;
    }
    this.pending.splice(0, taken);

    this.sending = true;
    this.lastSentAt = this.now();
    try {
      await this.send(body);
    } catch {
      // A failed send loses its lines; the next ones still go out.
    } finally {
      this.sending = false;
      this.schedule();
    }
  }
}
