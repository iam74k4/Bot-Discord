/**
 * Rendered name announcements, kept so a speaker's name plays at once.
 *
 * A name is announced every time the speaker changes, and in a voice channel
 * the same handful of people take turns, so the same few names are rendered
 * over and over. Each costs a full engine round trip (about 0.4 s) before
 * the line can start. Whole messages are not cached: they rarely repeat.
 *
 * The key includes the voice and speed, which change how the name sounds. A
 * renamed member simply misses. Entries are 48 kHz stereo PCM (about 150 KB
 * for a short name), bounded by count and by bytes, least recently used out.
 */

export const NAME_CACHE_MAX_ENTRIES = 32;
export const NAME_CACHE_MAX_BYTES = 6 * 1024 * 1024;

export class NameAudioCache {
  private readonly entries = new Map<string, Buffer>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = NAME_CACHE_MAX_ENTRIES,
    private readonly maxBytes = NAME_CACHE_MAX_BYTES
  ) {}

  static key(name: string, speakerId: number, speed: number): string {
    return `${speakerId}|${speed}|${name}`;
  }

  get size(): number {
    return this.entries.size;
  }

  get byteLength(): number {
    return this.bytes;
  }

  get(name: string, speakerId: number, speed: number): Buffer | undefined {
    const key = NameAudioCache.key(name, speakerId, speed);
    const pcm = this.entries.get(key);
    if (pcm) {
      // Most recently used goes to the back.
      this.entries.delete(key);
      this.entries.set(key, pcm);
    }
    return pcm;
  }

  set(name: string, speakerId: number, speed: number, pcm: Buffer): void {
    if (pcm.length === 0 || pcm.length > this.maxBytes) return;
    const key = NameAudioCache.key(name, speakerId, speed);
    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.length;
      this.entries.delete(key);
    }
    this.entries.set(key, pcm);
    this.bytes += pcm.length;

    for (const [oldest, audio] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) {
        break;
      }
      this.entries.delete(oldest);
      this.bytes -= audio.length;
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}
