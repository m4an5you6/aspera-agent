/** Service identity, retained-state presentation and operator-only calling examples. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { FleetExperiment } from '@aspera/dispatch/types'
import type { InferenceService } from '@aspera/experiments/types'
import type { ExperimentLocaleKey } from './locales.ts'

/** Client-only identity; never substitutes for the service's remote experiment owner. */
export type ServiceViewId = string & Branded<'ServiceViewId'>
/** A deduplicated service and the experiment under which it is displayed. */
export interface ServiceView {
  key: ServiceViewId
  service: InferenceService
  experimentName: string
  nodeName: string
  displayExperimentId: FleetExperiment['request']['experimentId']
}
/** Two operator examples share the service's registered public mapping. */
export type ServiceExampleKind = 'inference' | 'health'
/** Supported terminal syntaxes for copied examples. */
export type ServiceExampleLanguage = 'curl' | 'powershell'
/** Localized status text and the matching shared status primitives. */
export interface ServiceStatusView {
  label: ExperimentLocaleKey
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral'
  dot: 'done' | 'warning' | 'error' | 'ongoing' | 'idle'
}

/** @param service - registered process. @returns stable client identity across snapshots and display aliases. */
export function serviceViewId(service: InferenceService): ServiceViewId {
  return brandString<ServiceViewId>(JSON.stringify([service.experimentId, service.serverId, service.id]))
}

/**
 * Merge original and recovery snapshots without widening experiment-detail ownership.
 * @param rows - retained Host records.
 * @param experimentId - detail owner; omitted for the server-wide service view.
 * @param deletedIds - authoritative removal markers, including removed recovery runtimes.
 * @returns current services first, with one row per actual remote identity.
 */
export function collectServices(rows: readonly FleetExperiment[], experimentId?: string, deletedIds: readonly string[] = []): ServiceView[] {
  const deleted = new Set(deletedIds)
  const ids = new Set(experimentId === undefined ? rows.map(row => row.request.experimentId) : [experimentId])
  if (experimentId !== undefined) {
    for (let size = -1; size !== ids.size;) {
      size = ids.size
      for (const row of rows) {
        if (row.acceptanceParentId !== undefined && ids.has(row.acceptanceParentId)) ids.add(row.request.experimentId)
        if (ids.has(row.request.experimentId)) for (const id of row.acceptanceRecovery?.managedRuntimes ?? []) ids.add(id)
      }
    }
  }
  const found = new Map<ServiceViewId, { view: ServiceView; direct: boolean }>()
  for (const row of rows) {
    if (!ids.has(row.request.experimentId) || deleted.has(row.request.experimentId)) continue
    const parent = rows.find(item => item.request.experimentId === row.acceptanceParentId) ?? row
    for (const service of [...(row.latest?.services ?? row.receipt?.services ?? []), ...(row.acceptanceRecovery?.services ?? [])]) {
      if (deleted.has(service.experimentId)) continue
      const owner = rows.find(item => item.request.experimentId === service.experimentId)
      const display = rows.find(item => item.request.experimentId === owner?.acceptanceParentId) ?? parent
      const direct = row.request.experimentId === service.experimentId
      const key = serviceViewId(service)
      const previous = found.get(key)
      if (previous !== undefined && (previous.view.service.updatedAt > service.updatedAt
        || previous.view.service.updatedAt === service.updatedAt && (previous.direct || !direct))) continue
      found.set(key, { direct, view: { key, service, displayExperimentId: display.request.experimentId,
        experimentName: display.request.name ?? display.request.objective.split('\n')[0]!,
        nodeName: (owner ?? row).servers.find(server => server.id === service.serverId)?.name ?? service.serverId } })
    }
  }
  return [...found.values()].map(item => item.view).sort((a, b) => Number(a.service.released) - Number(b.service.released)
    || Number(b.service.state === 'healthy') - Number(a.service.state === 'healthy')
    || b.service.updatedAt - a.service.updatedAt || a.key.localeCompare(b.key))
}

/** @param service - request target. @returns process and calling identities that invalidate late replies when replaced. */
export function serviceRequestIdentity(service: InferenceService): string {
  return JSON.stringify([serviceViewId(service), service.commandId, service.createdAt, service.port, service.healthPath,
    service.modelName, service.external?.url])
}

/** @param service - saved process. @param uncertain - source cannot currently be confirmed. @param stopping - local stop request. @returns independent service summary. */
export function serviceStatus(service: InferenceService, uncertain = false, stopping = false): ServiceStatusView {
  if (service.released) return { label: service.state === 'failed' ? 'serviceFailedHistory' : 'serviceStoppedHistory', tone: 'neutral', dot: 'idle' }
  if (uncertain) return { label: 'serviceStatusUnconfirmed', tone: 'warning', dot: 'warning' }
  if (stopping || service.state === 'stopping') return { label: 'serviceExitPending', tone: 'warning', dot: 'ongoing' }
  if (service.state === 'healthy' && service.external?.state === 'unreachable') return { label: 'servicePublicBlocked', tone: 'warning', dot: 'warning' }
  if (service.state === 'healthy') return { label: 'serviceAvailable', tone: 'success', dot: 'done' }
  if (service.state === 'starting') return { label: 'starting', tone: 'info', dot: 'ongoing' }
  if (service.state === 'failed') return { label: 'failed', tone: 'danger', dot: 'error' }
  return { label: 'serviceHealthIssue', tone: 'warning', dot: 'warning' }
}

/** @param service - saved service. @param stopping - an in-flight stop. @returns a conclusive reason to block key retrieval; a failed status read is not such a reason. */
export function serviceKeyBlocker(service: InferenceService, stopping = false): ExperimentLocaleKey | undefined {
  if (service.released || service.external?.state === 'stopped') return 'serviceKeyStopped'
  if (service.external === undefined) return 'serviceKeyUnpublished'
  if (stopping || service.state === 'stopping') return 'serviceKeyStopping'
  return undefined
}

/**
 * Generate a template or an explicitly requested command with a calling key; never performs a request.
 * @param service - registered public address and model identity.
 * @param kind - model generation or gateway health.
 * @param language - terminal syntax.
 * @param message - localized example message.
 * @param setup - localized key setup instruction.
 * @param apiKey - fetched only for an explicit copy action; omitted for displayed templates.
 * @returns copyable text, or undefined when required calling information is missing.
 */
export function serviceExample(service: InferenceService, kind: ServiceExampleKind, language: ServiceExampleLanguage,
  message: string, setup: string, apiKey?: string): string | undefined {
  if (service.external === undefined || kind === 'inference' && service.modelName === undefined) return undefined
  const url = service.external.url.replace(/\/$/, '') + (kind === 'health' ? '/_aspera/health' : '/v1/chat/completions')
  const quote = (value: string) => "'" + value.replaceAll("'", language === 'curl' ? "'\\''" : "''") + "'"
  const header = `# ${setup}\n`
  const key = apiKey ?? 'YOUR_API_KEY'
  if (language === 'curl') {
    const authorization = `  -H ${quote('Authorization: Bearer ' + key)}`
    if (kind === 'health') return header + `curl ${quote(url)} \\\n${authorization}`
    const payload = JSON.stringify({ model: service.modelName, messages: [{ role: 'user', content: message }], max_tokens: 256, stream: false }, null, 2)
    return header + `curl -X POST ${quote(url)} \\\n${authorization} \\\n  -H 'Content-Type: application/json' \\\n  --data-raw ${quote(payload)}`
  }
  const credentials = `$apiKey = ${quote(key)}\n\n`
  const body = kind === 'health' ? '' : `$body = @{\n    model = ${quote(service.modelName!)}\n    messages = @(\n        @{\n            role = 'user'\n            content = ${quote(message)}\n        }\n    )\n    max_tokens = 256\n    stream = $false\n} | ConvertTo-Json -Depth 6\n\n`
  const parameters = `$params = @{\n    Uri = ${quote(url)}\n    Method = '${kind === 'health' ? 'GET' : 'POST'}'\n    Headers = @{\n        Authorization = "Bearer $apiKey"\n    }${kind === 'health' ? '' : "\n    ContentType = 'application/json; charset=utf-8'\n    Body = [System.Text.Encoding]::UTF8.GetBytes($body)"}\n}\n\n`
  const response = `if ($PSVersionTable.PSVersion.Major -lt 6) {\n    $raw = Invoke-WebRequest @params -UseBasicParsing\n    $response = [System.Text.Encoding]::UTF8.GetString(\n        $raw.RawContentStream.ToArray()\n    ) | ConvertFrom-Json\n} else {\n    $response = Invoke-RestMethod @params\n}\n\n`
  return header + credentials + body + parameters + response + (kind === 'health' ? '$response' : '$response.choices[0].message.content')
}
