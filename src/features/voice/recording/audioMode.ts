/**
 * What a voice connection does with the audio it hears. Kept apart from the
 * connection manager so code that only asks the question does not depend on
 * (or, in tests, have to fake) the manager itself.
 *
 * - deafened (`receiving: false`): a join only to read chat aloud;
 * - listening (`buffering: false`): a join for captions, which keeps nothing;
 * - buffering: the default, keeping audio for `/voice record`.
 */
export interface AudioMode {
  receiving?: boolean;
  buffering?: boolean;
}

/** True when a connection keeps what it hears in the record buffer. */
export function keepsAudio(info: AudioMode): boolean {
  return info.receiving !== false && info.buffering !== false;
}
