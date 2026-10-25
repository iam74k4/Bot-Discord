/**
 * How late a chunk may arrive before placement snaps back to its arrival
 * time: 60 ms at 48 kHz, three Opus frames.
 */
export const RESYNC_LATE_SAMPLES = 2880;

/**
 * How far a speaker's placement may run ahead of the wall clock before
 * frames are dropped to let it catch up: one second at 48 kHz.
 */
export const MAX_LEAD_SAMPLES = 48_000;

/**
 * Where each decoded 20 ms chunk of one speaker goes on the mix ring.
 *
 * Placing every chunk at its own arrival time turns network jitter and
 * event-loop stalls into audible damage: frames that queued up during a
 * stall all land on roughly the same slot (stacked, with a hole before
 * them), and ordinary jitter overlaps or gaps most joins by a millisecond or
 * two. Within one talk spurt the frames are contiguous audio, so they are laid
 * end to end instead, and the placement only snaps forward to the arrival
 * time when the stream fell clearly behind (a real pause or lost packets).
 *
 * It never moves backwards: re-syncing to an earlier position would write a
 * burst on top of audio already placed. The cost is that after a stall a
 * speaker runs ahead of the wall clock by up to the stall's length until
 * their stream ends (1.5 s of silence starts a fresh placer). A stream that
 * never pauses (an open mic, a music bot) would keep every such lead, so
 * once it exceeds `MAX_LEAD_SAMPLES` incoming frames are dropped until the
 * wall clock catches up: one short gap in that speaker's audio instead of
 * their newest audio sitting in the future, missing from every recording.
 */
export class ChunkPlacer {
  private next: number | null = null;
  private catchingUp = false;

  /**
   * @param arrivalEnd global sample index of "now" on the ring (the end of
   *   the chunk if it had been placed at its arrival time)
   * @param samples length of the chunk in samples
   * @returns the global index the chunk starts at, or null to drop it
   */
  place(arrivalEnd: number, samples: number): number | null {
    const arrival = arrivalEnd - samples;
    if (this.next === null || arrival > this.next + RESYNC_LATE_SAMPLES) {
      this.next = arrival;
      this.catchingUp = false;
    } else if (this.catchingUp || this.next - arrival > MAX_LEAD_SAMPLES) {
      // Too far ahead: drop frames, never overwrite, until the clock is back.
      this.catchingUp = arrival < this.next;
      if (this.catchingUp) return null;
    }
    const start = this.next;
    this.next += samples;
    return start;
  }
}
