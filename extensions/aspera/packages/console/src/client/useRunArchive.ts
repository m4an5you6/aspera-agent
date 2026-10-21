/** Detail-owned copy reads remain active while the overview card is unmounted. */
import { useEffect, useRef, useState } from 'react'
import type { ExperimentArchiveStatus, ExperimentId } from '@aspera/experiments/types'
import type { ExperimentsController } from './controller.ts'

/** @param controller - local Host copy API. @param id - selected experiment. @param enabled - remote handover exists.
 * @returns retained copy status and a coalesced explicit synchronization action.
 */
export function useRunArchive(controller: ExperimentsController, id: ExperimentId, enabled: boolean) {
  const [view, setView] = useState<{ id: ExperimentId; status?: ExperimentArchiveStatus; error?: string; syncing: boolean }>({ id, syncing: false })
  const lifetime = useRef<{ sync: () => void }>({ sync: () => {} })
  useEffect(() => {
    let alive = true; let pending = false; let syncing = false
    setView({ id, syncing: false })
    const load = async () => {
      if (!alive || pending) return
      pending = true
      try {
        const status = await controller.archiveStatus(id)
        if (alive && status.experimentId === id) setView({ id, status, syncing })
      } catch (error) { if (alive) setView(previous => ({ ...previous, error: String(error) })) }
      finally { pending = false }
    }
    const current = { sync: () => {
      if (!alive || !enabled || syncing) return
      syncing = true; setView(previous => ({ ...previous, syncing: true }))
      void controller.syncArchive(id)
        .then(() => { if (alive) return load() })
        .catch(error => { if (alive) setView(previous => ({ ...previous, error: String(error) })) })
        .finally(() => { if (alive) { syncing = false; setView(previous => ({ ...previous, syncing: false })) } })
    } }
    lifetime.current = current
    if (!enabled) return () => { alive = false }
    void load()
    const timer = setInterval(() => { void load() }, controller.displayLimits().pollIntervalMs)
    return () => { alive = false; clearInterval(timer) }
  }, [controller, id, enabled])
  return { ...(view.id === id ? view : { id, syncing: false }), sync: () => { lifetime.current.sync() } }
}
