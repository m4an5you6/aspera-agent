/** Local display preferences never modify remote plans or credentials. */
import { experimentModelsSchema } from '@aspera/experiments'
import type { ExperimentModels } from '@aspera/experiments/types'

/** Browser-local view choices. */
export interface AsperaPreferences { collapsed: boolean; dismissed: string[]; models?: ExperimentModels }
const key = 'aspera.console.preferences.v1'
/** @returns validated preferences; an unavailable browser store uses in-memory defaults. */
export function readPreferences(): AsperaPreferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    if (typeof value !== 'object' || value === null) return { collapsed: false, dismissed: [] }
    const models = experimentModelsSchema.safeParse('models' in value ? value.models : undefined)
    const dismissed = 'dismissed' in value && Array.isArray(value.dismissed) ? value.dismissed.filter((item): item is string => typeof item === 'string') : []
    return { collapsed: 'collapsed' in value && value.collapsed === true, dismissed, ...(models.success ? { models: models.data } : {}) }
  } catch (error) { void error; return { collapsed: false, dismissed: [] } } // Restricted storage must not prevent navigation.
}
/** @param value - non-secret UI choices. */
export function savePreferences(value: AsperaPreferences): void {
  try { localStorage.setItem(key, JSON.stringify(value)) }
  catch (error) { void error } // The current window retains its choice when storage is unavailable.
}
