/**
 * The controls, as opposed to the commands.
 *
 * What the agent asks for is discrete — walk this far, turn that much — and
 * queues up. A held key is neither, so it comes in through here instead, read
 * once a frame like the audio levels rather than pushed. Whoever is at the
 * keyboard wins: pressing a key while the bot is carrying out a command has
 * just contradicted it.
 *
 * Kept in its own module with no imports so the UI can name the type without
 * dragging Babylon into the first-load bundle.
 */
export interface DriveInput {
  /** -1 to 1. Positive walks forward. */
  forward: number;
  /** -1 to 1. Positive turns to the bot's own left, matching `movement.turn_left`. */
  turn: number;
  /** Held run modifier. */
  boost: boolean;
}

export function neutralDrive(): DriveInput {
  return { forward: 0, turn: 0, boost: false };
}
