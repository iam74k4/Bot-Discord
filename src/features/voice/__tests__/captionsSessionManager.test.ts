import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const {
  CaptionSessionManager,
  ENGINE_TROUBLE_AFTER,
  MAX_WAIT_MS,
  MAX_WAITING,
  formatCaption,
} = await import('../captions/sessionManager.js');
const { logger } = await import('../../../shared/utils/logger.js');

type Transcript = { text: string; segments: Array<{ text: string }> };

const GUILD = 'guild-1';
const VC = 'vc-1';
/** 20 ms of 48 kHz mono 16-bit PCM. */
const CHUNK_SAMPLES = 960;

function chunk(amplitude = 8_000): Buffer {
  const pcm = Buffer.alloc(CHUNK_SAMPLES * 2);
  for (let i = 0; i < CHUNK_SAMPLES; i++) {
    pcm.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  }
  return pcm;
}

function said(text: string): Transcript {
  return { text, segments: [{ text }] };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let clock: number;
let consented: Set<string>;
let transcribe: ReturnType<typeof vi.fn<(wav: Buffer) => Promise<Transcript>>>;
let manager: InstanceType<typeof CaptionSessionManager>;
let post: ReturnType<typeof vi.fn<(content: string) => Promise<void>>>;
let onEngineTrouble: ReturnType<typeof vi.fn<() => void>>;

const NAMES: Record<string, string> = { alice: 'Alice', bob: 'Bob' };

function start(voiceChannelId = VC, guildId = GUILD) {
  return manager.start({
    guildId,
    voiceChannelId,
    startedBy: 'alice',
    post,
    nameOf: (userId) => NAMES[userId] ?? userId,
    onEngineTrouble,
  });
}

/** One utterance: `ms` of speech, then the stream ends. */
function speak(
  userId: string,
  { ms = 1_000, amplitude = 8_000, channelId = VC } = {}
): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 20) {
    manager.onAudio(channelId, userId, chunk(amplitude), clock + elapsed);
  }
  manager.onSpeechEnd(channelId, userId);
}

/** Let the engine answer and the poster send. */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.clearAllMocks();
  clock = 1_000_000;
  consented = new Set(['guild-1:alice', 'guild-1:bob']);
  transcribe = vi.fn(async () => said('こんにちは'));
  post = vi.fn(async () => undefined);
  onEngineTrouble = vi.fn();
  manager = new CaptionSessionManager(
    {
      transcribe: (wav) => transcribe(wav),
      hasConsented: (guildId, userId) => consented.has(`${guildId}:${userId}`),
    },
    () => clock
  );
});

afterEach(() => {
  manager.stopAll();
  vi.useRealTimers();
});

describe('formatCaption', () => {
  it('puts the name in bold and escapes markdown in both parts', () => {
    expect(formatCaption('a_b', 'say *this*')).toBe(
      '**a\\_b**: say \\*this\\*'
    );
  });
});

describe('CaptionSessionManager', () => {
  it("posts a consenting speaker's words in the channel's chat", async () => {
    start();

    speak('alice');
    await settle();

    expect(transcribe).toHaveBeenCalledTimes(1);
    // 16 kHz mono WAV: header plus a third of the input samples.
    const wav = transcribe.mock.calls[0][0];
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(post).toHaveBeenCalledWith('**Alice**: こんにちは');
  });

  it('never sends the audio of someone who has not consented', async () => {
    consented.delete('guild-1:bob');
    start();

    speak('bob');
    await settle(5_000);

    expect(transcribe).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('keeps consent to the server it was given in', async () => {
    start('vc-2', 'guild-2');

    speak('alice', { channelId: 'vc-2' });
    await settle(5_000);

    expect(transcribe).not.toHaveBeenCalled();
  });

  it('drops what was collected when consent is withdrawn mid-sentence', async () => {
    start();

    for (let i = 0; i < 30; i++) {
      manager.onAudio(VC, 'alice', chunk(), clock + i * 20);
    }
    consented.delete('guild-1:alice');
    manager.onAudio(VC, 'alice', chunk(), clock + 600);
    consented.add('guild-1:alice');
    manager.onSpeechEnd(VC, 'alice');
    await settle(5_000);

    expect(transcribe).not.toHaveBeenCalled();
  });

  it('ignores audio from channels without a session', async () => {
    start();

    speak('alice', { channelId: 'vc-elsewhere' });
    await settle(5_000);

    expect(transcribe).not.toHaveBeenCalled();
  });

  it('skips near-silent utterances instead of asking the engine', async () => {
    start();

    speak('alice', { amplitude: 20 });
    await settle(5_000);

    expect(transcribe).not.toHaveBeenCalled();
  });

  it('posts nothing for a transcript the filter rejects', async () => {
    transcribe.mockResolvedValue(said('ご視聴ありがとうございました'));
    start();

    speak('alice');
    await settle(5_000);

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });

  it('posts lines in the order they were spoken, batched under the rate limit', async () => {
    const answers = [said('一つ目'), said('二つ目'), said('三つ目')];
    transcribe.mockImplementation(async () => answers.shift() ?? said(''));
    start();

    speak('alice');
    speak('bob');
    speak('alice');
    await settle(5_000);

    expect(post.mock.calls.map(([content]) => content).join('\n')).toBe(
      ['**Alice**: 一つ目', '**Bob**: 二つ目', '**Alice**: 三つ目'].join('\n')
    );
  });

  it('drops what a speaker has waiting when they withdraw consent', async () => {
    const first = deferred<Transcript>();
    transcribe.mockImplementationOnce(() => first.promise);
    start();

    speak('bob');
    speak('alice');
    await settle();
    expect(transcribe).toHaveBeenCalledTimes(1);

    consented.delete('guild-1:alice');
    manager.forgetUser(GUILD, 'alice');
    first.resolve(said('ボブです'));
    await settle(5_000);

    // Bob's line still goes out; Alice's never reached the engine.
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('**Bob**: ボブです');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not post a line whose speaker withdrew while the engine worked on it', async () => {
    const first = deferred<Transcript>();
    transcribe.mockImplementationOnce(() => first.promise);
    start();

    speak('alice');
    await settle();
    consented.delete('guild-1:alice');
    first.resolve(said('取り消し前'));
    await settle(5_000);

    expect(post).not.toHaveBeenCalled();
  });

  it(`keeps at most ${MAX_WAITING} utterances waiting, dropping the oldest`, async () => {
    const first = deferred<Transcript>();
    transcribe.mockImplementationOnce(() => first.promise);
    start();

    speak('alice'); // at the engine
    for (let i = 0; i < MAX_WAITING + 1; i++) speak('bob');
    await settle();
    first.resolve(said('最初'));
    await settle(10_000);

    expect(transcribe).toHaveBeenCalledTimes(1 + MAX_WAITING);
  });

  it(`drops an utterance that waited longer than ${MAX_WAIT_MS} ms`, async () => {
    const first = deferred<Transcript>();
    transcribe.mockImplementationOnce(() => first.promise);
    start();

    speak('alice');
    speak('bob');
    await settle();
    clock += MAX_WAIT_MS + 1;
    first.resolve(said('最初'));
    await settle(5_000);

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('**Alice**: 最初');
  });

  it(`tells the channel once after ${ENGINE_TROUBLE_AFTER} failures in a row, and again after a recovery`, async () => {
    transcribe.mockRejectedValue(new Error('down'));
    start();

    for (let i = 0; i < ENGINE_TROUBLE_AFTER + 2; i++) speak('alice');
    await settle(5_000);
    expect(onEngineTrouble).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    transcribe.mockResolvedValueOnce(said('復活'));
    speak('alice');
    await settle(5_000);
    // The count starts over after a success.
    for (let i = 0; i < ENGINE_TROUBLE_AFTER - 1; i++) speak('alice');
    await settle(5_000);
    expect(onEngineTrouble).toHaveBeenCalledTimes(1);

    speak('alice');
    await settle(5_000);
    expect(onEngineTrouble).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledWith('**Alice**: 復活');
  });

  it('survives a trouble notice that throws', async () => {
    transcribe.mockRejectedValue(new Error('down'));
    onEngineTrouble.mockImplementation(() => {
      throw new Error('no permission');
    });
    start();

    for (let i = 0; i < ENGINE_TROUBLE_AFTER; i++) speak('alice');
    await settle(5_000);

    expect(onEngineTrouble).toHaveBeenCalledTimes(1);
  });

  it('posts nothing more once stopped, even for a line the engine was working on', async () => {
    const first = deferred<Transcript>();
    transcribe.mockImplementationOnce(() => first.promise);
    start();

    speak('alice');
    speak('bob');
    await settle();
    expect(manager.stop(VC)).toBe(true);
    first.resolve(said('遅れて届いた'));
    speak('alice');
    await settle(5_000);

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(manager.get(VC)).toBeUndefined();
    expect(manager.stop(VC)).toBe(false);
  });

  it('keeps one session per guild, and the existing one when started again', () => {
    const first = start('vc-1');
    expect(start('vc-1')).toBe(first);

    start('vc-2');

    expect(manager.get('vc-1')).toBeUndefined();
    expect(manager.getForGuild(GUILD)?.voiceChannelId).toBe('vc-2');
    expect(manager.getForGuild('guild-other')).toBeUndefined();
  });

  it('ends a session with its connection', () => {
    start();

    manager.handleDisconnect(VC);
    manager.handleDisconnect(VC);

    expect(manager.get(VC)).toBeUndefined();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('ignores the end of a stream it never collected', () => {
    start();

    expect(() => manager.onSpeechEnd(VC, 'nobody')).not.toThrow();
    expect(() => manager.onSpeechEnd('vc-none', 'alice')).not.toThrow();
  });
});
