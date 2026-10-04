/** Cleanup only traverses saved experiment-owned locations. */
import { existsSync, lstatSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type { ExperimentId } from '@aspera/experiments'

/** Remove local uploaded copies, never the user's original inputs.
 * @param root - private upload root. @param id - validated experiment identity.
 */
export function cleanupLocalInputs(root: string, id: ExperimentId): void {
  const base = resolve(root)
  const target = resolve(base, id)
  if (relative(base, target) !== id || target === base) throw new Error('Input cleanup exceeds the experiment directory')
  if (!existsSync(target)) return
  if (lstatSync(target).isSymbolicLink()) { unlinkSync(target); return }
  const actualRoot = realpathSync(base)
  if (!realpathSync(target).startsWith(actualRoot + sep)) throw new Error('Input cleanup resolves outside its private root')
  rmSync(target, { recursive: true, force: true })
}
