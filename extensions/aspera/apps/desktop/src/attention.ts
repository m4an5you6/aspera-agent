/** The desktop accepts only a count from its owned application frame. */
import z from 'zod'

/** Validated IPC payload; badges never accept text, paths or commands. */
export const attentionCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Select the fixed packaged numeric artwork.
 * @param count - validated pending experiment count. @returns empty, 1–99 or 99+.
 */
export function attentionArtwork(count: number): string { return count === 0 ? '' : count > 99 ? '99+' : String(count) }
