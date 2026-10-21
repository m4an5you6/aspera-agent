/** Measured package reuse and candidate-bound cleanup accompany saved experiment information. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Tag, StateDot, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExperimentStorageUsage, ExperimentCachePreview, EnvironmentReusePlan, MaterialOperation, StoragePlacement } from '@aspera/experiments/types'
import type { ExperimentsController } from './controller.ts'
import css from './ExperimentsPage.module.css'

const reuseStageLabels = { checking: 'environmentCheckingReuse', reusing: 'environmentReusingPackages', downloading: 'environmentDownloadingMissing',
  installing: 'environmentInstallingMissing', verifying: 'environmentProgramVerification', recovering: 'environmentRecoveringOperation',
  completed: 'environmentReady', blocked: 'environmentBlocked' } as const satisfies Record<EnvironmentReusePlan['stage'], string>
const categoryLabels = { release: 'storageCategoryRelease', environment: 'storageCategoryEnvironment', package: 'storageCategoryPackage',
  model: 'storageCategoryModel', dataset: 'storageCategoryDataset', temporary: 'storageCategoryTemporary', checkpoint: 'storageCategoryCheckpoint',
  result: 'storageCategoryResult', log: 'storageCategoryLog', other: 'storageCategoryOther' } as const
const materialStageLabels = { checking: 'environmentCheckingReuse', 'waiting-transfer': 'storageWaitingTransfer', reusing: 'environmentReusingPackages',
  downloading: 'storageMaterialDownloading', verifying: 'environmentProgramVerification', publishing: 'storagePublishingMaterial',
  'waiting-exit': 'environmentWaitingExit', completed: 'storageMaterialReady', blocked: 'environmentBlocked' } as const satisfies Record<NonNullable<MaterialOperation['stage']>, string>

/** @param props - pinned experiment and program-owned actions. @returns real measurements with offline and cleanup diagnostics. */
export function EnvironmentStorage({ id, controller, t, active, placements = [] }: { id: string; controller: ExperimentsController; t: TranslateNS<'experiments'>; active: boolean; placements?: StoragePlacement[] }) {
  const [usage, setUsage] = useState<ExperimentStorageUsage>()
  const [error, setError] = useState<string>()
  const [preview, setPreview] = useState<ExperimentCachePreview>()
  const [busy, setBusy] = useState<'preview' | 'cleanup' | 'scan'>()
  const [selection, setSelection] = useState<Record<string, string[]>>({})
  const [scanningNode, setScanningNode] = useState<string>()
  const [selectedNode, setSelectedNode] = useState<string>()
  const focus = useSyncExternalStore(controller.store.subscribe, () => controller.store.getSnapshot().storageFocus)
  const operation = useRef<string>()
  const lifetime = useRef({ active: true })
  const openDetails = (serverId: string) => {
    setPreview(undefined); setSelection({}); operation.current = undefined; setSelectedNode(serverId)
  }
  const gib = (bytes: number) => t(bytes >= 1024 ** 3 ? 'environmentGiB' : bytes >= 1024 ** 2 ? 'environmentMiB' : 'environmentKiB',
    { size: (bytes / (bytes >= 1024 ** 3 ? 1024 ** 3 : bytes >= 1024 ** 2 ? 1024 ** 2 : 1024)).toLocaleString(undefined, { maximumFractionDigits: 2 }) })
  useEffect(() => {
    const current = { active: true }; lifetime.current = current
    let pending = false
    const load = async () => {
      if (!current.active || pending) return
      pending = true
      try {
        const next = await controller.storageUsage(id)
        if (current.active && next.experimentId === id) { setUsage(next); setError(undefined) }
      } catch (failure) { if (current.active) setError(String(failure)) }
      finally { pending = false }
    }
    setUsage(undefined); setPreview(undefined); setError(undefined); setBusy(undefined); setSelection({}); setSelectedNode(undefined); operation.current = undefined
    void load(); const timer = setInterval(() => { void load() }, controller.displayLimits().pollIntervalMs)
    return () => { current.active = false; clearInterval(timer) }
  }, [id, controller])
  useEffect(() => { if (focus?.experimentId === id && focus.serverId !== selectedNode && busy === undefined) openDetails(focus.serverId) }, [focus, id, selectedNode, busy])
  const inspectCleanup = async () => {
    const current = lifetime.current; setBusy('preview')
    try { const next = await controller.cachePreview(id); if (current.active && next.experimentId === id) { setPreview(next); setSelection({}); setError(undefined); operation.current = undefined } }
    catch (failure) { if (current.active) setError(String(failure)) }
    finally { if (current.active) setBusy(undefined) }
  }
  const cleanup = async () => {
    if (preview === undefined || busy) return
    const current = lifetime.current; setBusy('cleanup')
    operation.current ??= controller.newId()
    try {
      const result = await controller.cleanupCache(preview, operation.current, selection)
      if (current.active) {
        if (result.nodes.every(node => node.state === 'completed')) {
          const next = await controller.storageUsage(id)
          if (current.active && next.experimentId === id) { setPreview(undefined); setUsage(next); setError(undefined) }
        }
        else setError(result.nodes.filter(node => node.state === 'blocked').map(node => node.detail).filter(Boolean).join('\n'))
      }
    } catch (failure) { if (current.active) setError(String(failure)) }
    finally { if (current.active) setBusy(undefined) }
  }
  const scan = async (serverId: string, cursor?: string) => {
    const current = lifetime.current; setBusy('scan'); setScanningNode(serverId)
    try {
      const next = await controller.refreshStorage(id, serverId, cursor)
      if (current.active && next.experimentId === id) { setUsage(next); setError(undefined) }
    } catch (failure) { if (current.active) setError(String(failure)) }
    finally { if (current.active) { setBusy(undefined); setScanningNode(undefined) } }
  }
  return <section className={css.infoSection} aria-label={t('environmentStorage')}>
    <h3>{t('environmentStorage')}</h3>
    {usage === undefined && error === undefined && <StateDot state="ongoing" />}
    {usage?.nodes.map(node => <div className={css.storageSummary} key={node.serverId}>
      <div className={css.sectionHeading}><strong>{node.name}</strong><Tag tone={node.storagePlan?.state === 'insufficient' ? 'warning' : 'neutral'}>{t(node.source === 'local' ? 'environmentOffline' : node.storagePlan?.state === 'insufficient' ? 'storageBudgetInsufficient' : node.storagePlan?.state === 'ready' ? 'storageBudgetReady' : 'storageBudgetPending')}</Tag></div>
      <StorageAllocations node={node} placement={placements.find(value => value.serverId === node.serverId)} t={t} gib={gib} compact />
      {node.arrangement !== undefined && <Tag tone="warning">{t('storageSystemFallback')}</Tag>}
      {node.storagePlan?.volumes.filter(volume => (volume.shortfallBytes ?? 0) > 0).map(volume => <p className={css.issueSummary} key={volume.directory}>{t('storageGapSummary', { volume: volume.directory, size: gib(volume.shortfallBytes!) })}</p>)}
      <p className={css.hint}>{node.checkedAt > 0 ? t('environmentCheckedAt', { time: new Date(node.checkedAt).toLocaleString() }) : t('storageUnconfirmed')}</p>
      {node.error && <span className={css.hint}>{t('environmentReadIssue')}</span>}
      <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={() => { openDetails(node.serverId) }}>{t('storageDetails')}</Button>
    </div>)}
    {error && <p className={css.hint} role="status">{t('storageRetainedRead')}</p>}
    <Modal open={selectedNode !== undefined} onClose={() => { setSelectedNode(undefined); controller.clearStorageFocus() }} title={t('storageDetails')} closeLabel={t('close')} className={css.storageModal} contentClassName={css.storageModalContent} backdropBlur={false}>
    {usage?.nodes.filter(node => node.serverId === selectedNode).map(node => <div className={css.environmentNode} key={node.serverId}>
      <div className={css.sectionHeading}><strong>{node.name}</strong><Tag>{t(node.source === 'local' ? 'environmentOffline' : node.source === 'ssh' ? 'environmentSshRead' : 'environmentMeasured')}</Tag></div>
      <StorageAllocations node={node} placement={placements.find(value => value.serverId === node.serverId)} t={t} gib={gib} />
      {node.arrangement !== undefined && <details className={css.infoDisclosure}><summary>{t('storageHistory')}</summary><p>{node.arrangement.reason}</p><pre className={css.log}>{JSON.stringify(node.arrangement, null, 2)}</pre></details>}
      {placements.find(value => value.serverId === node.serverId) !== undefined && <details className={css.infoDisclosure}><summary>{t('selectionReason')}</summary><p>{placements.find(value => value.serverId === node.serverId)?.reason}</p></details>}
      {node.checkedAt > 0 && <p className={css.hint}>{t('environmentCheckedAt', { time: new Date(node.checkedAt).toLocaleString() })}</p>}
      {node.catalog && <div className={css.environmentRow}>
        <div className={css.sectionHeading}><span>{t('storageAccountInventory')}</span><Tag>{t(node.catalog.complete ? 'storageInventoryComplete' : 'storageInventoryIncomplete')}</Tag></div>
        <p className={css.hint}>{t('storageVisibilityHint')}</p>
        {node.catalog.volumes.map(volume => <div className={css.environmentRow} key={volume.id}>
          <code className={css.storagePath}>{volume.directory} · {volume.filesystem}</code>
          <dl className={css.infoFacts}>
            <div><dt>{t('storageCapacity')}</dt><dd>{gib(volume.capacityBytes)}</dd></div>
            <div><dt>{t('environmentAvailable')}</dt><dd>{gib(volume.availableBytes)}</dd></div>
            <div><dt>{t('storageAccountWrite')}</dt><dd>{t(volume.accountWritable === null ? 'storageUnconfirmed' : volume.accountWritable ? 'storageWritable' : 'storageReadonly')}</dd></div>
            <div><dt>{t('storageUnattributed')}</dt><dd>{gib(volume.unattributedBytes)}</dd></div>
            {volume.categories.map(category => <div key={category.kind}><dt>{t(categoryLabels[category.kind])}</dt><dd>{gib(category.allocatedBytes)}</dd></div>)}
          </dl>
        </div>)}
        <p className={css.hint}>{t('storageAccountingHint')}</p>
        <p className={css.hint}>{t('environmentCheckedAt', { time: new Date(node.catalog.checkedAt).toLocaleString() })}</p>
        <Button variant="ghost" disabled={busy !== undefined} aria-busy={busy === 'scan' && scanningNode === node.serverId}
          onClick={() => { void scan(node.serverId, node.catalog?.cursor) }}>
          {busy === 'scan' && scanningNode === node.serverId && <StateDot state="ongoing" />}{t(node.catalog.cursor ? 'storageContinueScan' : 'storageRefreshScan')}
        </Button>
        <details className={css.infoDisclosure}><summary>{t('storageInventoryDetails')}</summary><pre className={css.log}>{JSON.stringify(node.catalog, null, 2)}</pre></details>
      </div>}
      {node.storagePlan && <div className={css.environmentRow}>
        <div className={css.sectionHeading}><span>{t('storageCapacityPlan')}</span><Tag>{t(node.storagePlan.state === 'ready' ? 'storageBudgetReady' : node.storagePlan.state === 'insufficient' ? 'storageBudgetInsufficient' : 'storageBudgetPending')}</Tag></div>
        {node.storagePlan.volumes.map(volume => <dl className={css.infoFacts} key={volume.directory}>
          <div><dt>{t('storageVolume')}</dt><dd><code>{volume.directory}</code></dd></div>
          <div><dt>{t('storageRequired')}</dt><dd>{volume.requiredBytes === null ? t('storageUnconfirmed') : gib(volume.requiredBytes)}</dd></div>
          <div><dt>{t('storageReserved')}</dt><dd>{gib(volume.reservedBytes)}</dd></div>
          <div><dt>{t('environmentAvailable')}</dt><dd>{gib(volume.availableBytes)}</dd></div>
          <div><dt>{t('storageReserve')}</dt><dd>{gib(volume.safetyBytes)}</dd></div>
          <div><dt>{t('storageNewPeak')}</dt><dd>{volume.newPeakBytes == null ? t('storageUnconfirmed') : gib(volume.newPeakBytes)}</dd></div>
          <div><dt>{t('storageShortfall')}</dt><dd>{volume.shortfallBytes == null ? t('storageUnconfirmed') : gib(volume.shortfallBytes)}</dd></div>
        </dl>)}
        <p className={css.hint}>{t('environmentCheckedAt', { time: new Date(node.storagePlan.checkedAt).toLocaleString() })}</p>
        {node.storagePlan.fallbackAssessment !== undefined && !node.storagePlan.fallbackAssessment.applied && <p className={css.hint}>{t('storageFallbackShortfall', { system: gib(node.storagePlan.fallbackAssessment.systemShortfallBytes), data: gib(node.storagePlan.fallbackAssessment.remainingDataShortfallBytes) })}</p>}
        {node.storagePlan.state === 'insufficient' && <p className={css.hint}>{t('storageCapacityActions')}</p>}
        <details className={css.infoDisclosure}><summary>{t('technicalDetails')}</summary><pre className={css.log}>{JSON.stringify(node.storagePlan, null, 2)}</pre></details>
      </div>}
      {node.borrowings?.map(binding => <div className={css.environmentRow} key={binding.environmentId}>
        <div className={css.sectionHeading}><span>{binding.environmentId}</span><Tag>{t('storageBorrowedReadonly')}</Tag></div>
        <dl className={css.infoFacts}><div><dt>{t('storageSourceExperiment')}</dt><dd>{binding.sourceExperimentId}</dd></div>
          <div><dt>{t('environmentPython')}</dt><dd>{binding.pythonVersion}</dd></div></dl>
        <code className={css.storagePath}>{binding.python}</code>
        <p className={css.hint}>{t('environmentCheckedAt', { time: new Date(binding.checkedAt).toLocaleString() })}</p>
      </div>)}
      {node.assets?.map(material => <div className={css.environmentRow} key={material.id}>
        <div className={css.sectionHeading}><span>{material.repository}</span><Tag>{t(material.state === 'ready' ? 'storageMaterialReady' : material.state === 'downloading' ? 'storageMaterialDownloading' : 'storageMaterialPending')}</Tag></div>
        <dl className={css.infoFacts}><div><dt>{t('storageMaterialSize')}</dt><dd>{gib(material.totalBytes)}</dd></div>
          <div><dt>{t('storageMissingDownload')}</dt><dd>{gib(material.missingBytes)}</dd></div></dl>
        <code className={css.storagePath}>{material.revision}</code>
      </div>)}
      {node.materialOperations?.map(operation => <div className={css.environmentRow} key={operation.operationId}>
        <div className={css.sectionHeading}><span>{t(operation.stage === undefined ? 'storageMaterialOperation' : materialStageLabels[operation.stage])}</span>
          <StateDot state={operation.state === 'completed' && operation.admissionReleased ? 'done' : operation.state === 'blocked' || operation.state === 'unknown' ? 'warning' : active && node.source !== 'local' ? 'ongoing' : 'idle'} /></div>
        <dl className={css.infoFacts}><div><dt>{t('environmentDownloaded')}</dt><dd>{gib(operation.downloadedBytes)}</dd></div>
          <div><dt>{t('environmentReusedBytes')}</dt><dd>{gib(operation.reusedBytes)}</dd></div></dl>
        <p className={css.hint}>{t('environmentElapsed', { seconds: Math.floor(Math.max(0, operation.updatedAt - operation.startedAt) / 1000) })} · {t('environmentCheckedAt', { time: new Date(operation.updatedAt).toLocaleString() })}</p>
        <details className={css.infoDisclosure}><summary>{t('technicalDetails')}</summary><pre className={css.log}>{JSON.stringify(operation, null, 2)}</pre></details>
      </div>)}
      {Object.values(Object.fromEntries([...(node.operations ?? [])].sort((a, b) => (a.runtime?.startedAt ?? 0) - (b.runtime?.startedAt ?? 0))
        .map(operation => [operation.operation?.environmentId ?? operation.operationId, operation]))).map(operation => <div className={css.environmentRow} key={operation.operationId}>
        <div className={css.sectionHeading}><span>{operation.operation?.environmentId}</span><span className={css.nodeStatus}>
          <StateDot state={operation.state === 'completed' ? 'done' : operation.state === 'failed' || operation.state === 'unknown' ? 'warning' : active && node.source === 'remote' ? 'ongoing' : 'idle'} />
          <span>{t(operation.state === 'unknown' ? 'environmentOutcomeUnknown' : operation.state === 'failed' ? 'environmentBlocked'
            : operation.state === 'running' && operation.operation?.exitConfirmed ? 'environmentWaitingExit'
            : operation.state === 'completed' ? operation.operation?.environment?.requirements.length === 0 ? 'environmentInterpreterReady' : 'environmentReady'
            : operation.reusePlan === undefined ? 'environmentConfiguring' : reuseStageLabels[operation.reusePlan.stage])}</span>
        </span></div>
        <p className={css.hint}>{t('environmentElapsed', { seconds: Math.floor(operation.elapsedMs / 1000) })} · {t('environmentCheckedAt', { time: new Date(operation.checkedAt).toLocaleString() })}</p>
        <details className={css.infoDisclosure}><summary>{t('environmentDetails')}</summary><pre className={css.log}>{JSON.stringify(operation, null, 2)}</pre></details>
      </div>)}
      {Object.values(Object.fromEntries([...(node.reusePlans ?? [])].sort((a, b) => a.updatedAt - b.updatedAt).map(plan => [plan.environmentId, plan]))).map(plan => <div className={css.environmentRow} key={plan.environmentId + '-reuse'}>
        <div className={css.sectionHeading}><span>{plan.environmentId}</span><span className={css.nodeStatus}>
          <StateDot state={plan.stage === 'completed' ? 'done' : plan.stage === 'blocked' ? 'warning' : active && node.source !== 'local' ? 'ongoing' : 'idle'} />
          <span>{t(plan.stage === 'completed' && node.environments.find(environment => environment.environmentId === plan.environmentId)?.requirements.length === 0 ? 'environmentInterpreterReady' : reuseStageLabels[plan.stage])}</span>
        </span></div>
        <p className={css.hint}>{t('environmentCheckedAt', { time: new Date(plan.updatedAt).toLocaleString() })}</p>
        <dl className={css.infoFacts}><div><dt>{t('environmentDownloaded')}</dt><dd>{gib(plan.downloadBytes)}</dd></div><div><dt>{t('environmentReusedBytes')}</dt><dd>{gib(plan.reusedBytes)}</dd></div><div><dt>{t('environmentAdded')}</dt><dd>{gib(plan.addedBytes)}</dd></div></dl>
        <details className={css.infoDisclosure}><summary>{t('environmentReusePlan')}</summary><pre className={css.log}>{JSON.stringify(plan, null, 2)}</pre></details>
      </div>)}
      {(node.materials?.length ?? 0) > 0 && <details className={css.infoDisclosure}><summary>{t('environmentMaterials', { count: node.materials!.length })}</summary><p className={css.hint}>{t('environmentMaterialHint')}</p><pre className={css.log}>{JSON.stringify(node.materials, null, 2)}</pre></details>}
      {node.environments.length === 0 && (node.borrowings?.length ?? 0) === 0 ? <p className={css.hint}>{t('environmentNotManaged')}</p> : node.environments.map(environment => <div className={css.environmentRow} key={environment.environmentId}>
        <div className={css.sectionHeading}><span>{environment.environmentId}</span><span className={css.nodeStatus}>
          <StateDot state={environment.state === 'ready' ? node.cleanups?.some(row => row.environmentId === environment.environmentId && row.state === 'pending') ? 'warning' : 'done' : environment.state === 'blocked' ? 'warning' : active && node.source !== 'local' ? 'ongoing' : 'idle'} />
          <Tag>{t(environment.state === 'ready' ? node.cleanups?.some(row => row.environmentId === environment.environmentId && row.state === 'pending') ? 'environmentVerifiedPendingCleanup' : environment.requirements.length === 0 ? 'environmentInterpreterReady' : 'environmentReady' : environment.state === 'blocked' ? 'environmentNotVerified' : 'environmentConfiguring')}</Tag>
        </span></div>
        <dl className={css.infoFacts}>
          <div><dt>{t('environmentPython')}</dt><dd>{environment.pythonVersion}</dd></div>
          <div><dt>{t('environmentReuse')}</dt><dd>{[environment.sharing.hardlinkBytes > 0 && t('environmentHardlink'), environment.sharing.cloneBytes > 0 && t('environmentClone'), environment.sharing.copyBytes > 0 && t('environmentCopy')].filter(Boolean).join(' · ') || t('environmentEmpty')}</dd></div>
          <div><dt>{t('environmentAdded')}</dt><dd>{gib(environment.sharing.addedBytes)}</dd></div>
        </dl>
        <details className={css.infoDisclosure}><summary>{t('environmentDetails')}</summary><code className={css.storagePath}>{environment.python}</code><p className={css.hint}>{environment.purpose}</p>
          <dl className={css.infoFacts}><div><dt>{t('environmentSharedPayload')}</dt><dd>{gib(environment.sharing.hardlinkBytes)}</dd></div><div><dt>{t('environmentCloneEstimate')}</dt><dd>{gib(environment.sharing.cloneBytes)}</dd></div><div><dt>{t('environmentCopy')}</dt><dd>{gib(environment.sharing.copyBytes)}</dd></div></dl>
          <pre className={css.log}>{JSON.stringify({ requirements: environment.requirements, verification: environment.verification, reasons: environment.sharing.reasons }, null, 2)}</pre>
        </details>
      </div>)}
      {(node.cleanups?.length ?? 0) > 0 && <details className={css.infoDisclosure}><summary>{t('environmentCleanupDetails')}</summary><pre className={css.log}>{JSON.stringify(node.cleanups, null, 2)}</pre></details>}
      {(node.recoveries?.length ?? 0) > 0 && <details className={css.infoDisclosure}><summary>{t('environmentRecoveryDetails')}</summary><pre className={css.log}>{JSON.stringify(node.recoveries, null, 2)}</pre></details>}
      {node.checkedAt > 0 && <dl className={css.infoFacts}><div><dt>{t('environmentAvailable')}</dt><dd>{gib(node.availableBytes)}</dd></div><div><dt>{t('environmentReclaimable')}</dt><dd>{node.complete ? gib(node.reclaimableBytes) : t('environmentMeasurementPending')}</dd></div></dl>}
      {node.error && <details className={css.infoDisclosure}><summary>{t('environmentReadIssue')}</summary><pre className={css.log}>{node.error}</pre></details>}
      {node.legacy.length > 0 && <details className={css.infoDisclosure}><summary>{t('environmentLegacyCandidates', { count: node.legacy.length })}</summary><pre className={css.log}>{JSON.stringify(node.legacy, null, 2)}</pre></details>}
    </div>)}
    {error && <div className={css.hint} role="status">{t('environmentOperationIssue')}<details><summary>{t('technicalDetails')}</summary><pre className={css.log}>{error}</pre></details></div>}
    <Button variant="ghost" disabled={busy !== undefined} aria-busy={busy === 'preview'} onClick={() => { void inspectCleanup() }}>
      {busy === 'preview' && <StateDot state="ongoing" />}{t('environmentPreviewCleanup')}
    </Button>
    {preview && <div className={css.environmentPreview}><p className={css.hint}>{t('environmentCleanupHint')}</p>{preview.nodes.filter(node => node.serverId === selectedNode).map(node => <div key={node.serverId}>
      <p>{t(node.eligible ? 'environmentCleanupCandidate' : 'environmentCleanupUnavailable', { size: gib(node.candidates.reduce((sum, value) => sum + value.bytes, 0)) })}</p>
      {node.detail && <details><summary>{t('technicalDetails')}</summary><pre className={css.log}>{node.detail}</pre></details>}
      {node.eligible && node.candidates.map(candidate => <div className={css.environmentRow} key={candidate.id}><label>
        <input type="checkbox" checked={selection[node.serverId]?.includes(candidate.id) ?? false} disabled={busy !== undefined}
          aria-label={t('storageSelectCleanup', { id: candidate.id })}
          onChange={event => { const checked = event.currentTarget.checked; operation.current = undefined; setSelection(previous => ({ ...previous,
            [node.serverId]: checked ? [...(previous[node.serverId] ?? []), candidate.id] : (previous[node.serverId] ?? []).filter(id => id !== candidate.id) })) }} />
        <span>{t(candidate.kind === 'historical-temporary' ? 'storageHistoricalTemporary' : candidate.kind === 'temporary' ? 'storagePrivateTemporary' : 'storageSharedCache')} · {gib(candidate.bytes)}</span>
        </label>
        {candidate.sourceExperimentId && <code className={css.storagePath}>{candidate.sourceExperimentId}</code>}
        <details className={css.infoDisclosure}><summary>{t('technicalDetails')}</summary><pre className={css.log}>{candidate.reason}</pre></details>
      </div>)}
    </div>)}
      {preview.nodes.some(node => node.serverId === selectedNode && node.eligible && node.candidates.length > 0) && <Button disabled={busy !== undefined || !Object.values(selection).some(ids => ids.length > 0)} aria-busy={busy === 'cleanup'} onClick={() => { void cleanup() }}>
        {busy === 'cleanup' && <StateDot state="ongoing" />}{t('environmentCleanupAction')}
      </Button>}
    </div>}
    </Modal>
  </section>
}

function StorageAllocations({ node, placement, t, gib, compact = false }: { node: ExperimentStorageUsage['nodes'][number]; placement?: StoragePlacement;
  t: TranslateNS<'experiments'>; gib: (bytes: number) => string; compact?: boolean }) {
  const plan = node.storagePlan
  const env = node.environments.find(value => value.environmentId === plan?.environmentId) ?? node.environments[0]
  const borrowed = node.borrowings?.find(value => value.environmentId === plan?.environmentId) ?? node.borrowings?.[0]
  const materialIds = new Set(plan?.materialIds ?? node.materialOperations?.map(operation => operation.materialId) ?? [])
  const assets = node.assets?.filter(material => materialIds.has(material.id)) ?? []
  const operation = node.operations?.filter(value => (value.operation?.environmentId ?? value.reusePlan?.environmentId) === (plan?.environmentId ?? 'training')).sort((a, b) => a.checkedAt - b.checkedAt).at(-1)
  const environmentState = env?.state === 'ready' && env.verification?.verified === true || borrowed !== undefined ? 'environmentReady'
    : env?.state === 'blocked' || operation?.state === 'failed' ? 'environmentBlocked'
    : operation?.state === 'unknown' ? 'environmentOutcomeUnknown' : operation?.state === 'running' ? 'environmentConfiguring'
    : node.arrangement !== undefined ? 'storageArranged' : 'storageUnconfirmed'
  const materialState = assets.length === 0 ? 'storageUnconfirmed' : assets.some(value => value.state === 'blocked') ? 'environmentBlocked'
    : assets.some(value => value.state === 'downloading') ? 'storageMaterialDownloading' : assets.every(value => value.state === 'ready') ? 'storageMaterialReady' : 'storageMaterialPending'
  const rows = [
    { key: 'storageTrainingEnvironment', state: environmentState, directory: env?.directory ?? borrowed?.directory ?? node.arrangement?.environmentWorkspace, reuse: borrowed !== undefined || (env?.sharing.hardlinkBytes ?? 0) > 0, bytes: plan?.volumes.reduce<number | null>((sum, value) => sum === null || value.environmentBytes === null ? null : sum + value.environmentBytes, 0) },
    { key: 'storageModelsData', state: materialState, directory: [...new Set(assets.map(value => value.directory))].join('\n') || undefined, reuse: assets.some(value => value.verifiedBytes > 0), bytes: plan?.volumes.reduce((sum, value) => sum + value.missingBytes, 0) },
    { key: 'storageOutputs', state: plan?.state === 'ready' ? 'storageArranged' : plan?.state === 'insufficient' ? 'storageBudgetInsufficient' : 'storageUnconfirmed', directory: placement?.workspaceRoot, reuse: false, bytes: plan?.volumes.reduce((sum, value) => sum + value.outputBytes + value.checkpointBytes, 0) },
  ] as const
  if (compact) return <dl className={css.storageSummaryRows}>{rows.map(row => <div key={row.key}><dt>{t(row.key)}</dt><dd>{row.directory === undefined ? t('storageUnconfirmed') : <Tooltip label={row.directory} portal><button type="button" className={css.storageOneLine}>{row.directory}</button></Tooltip>}{row.reuse && <small>{t('storageReused')}</small>}</dd></div>)}</dl>
  return <div className={css.storageTableScroll}><table className={css.storageAllocationTable}><thead><tr>{(['storageContent', 'storageActualDirectory', 'environmentReuse', 'storageEstimatedPeak', 'status'] as const).map(key => <th key={key}>{t(key)}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.key}>
    <td>{t(row.key)}</td><td><code>{row.directory ?? t('storageUnconfirmed')}</code></td><td>{t(row.reuse ? 'storageReused' : row.key === 'storageOutputs' ? 'storageNotApplicable' : 'storageUnconfirmed')}</td><td>{row.bytes == null ? t('storageUnconfirmed') : t('storageEstimate', { size: gib(Math.ceil(row.bytes * (plan?.peakSafetyFactor ?? 1))) })}</td><td><Tag tone={row.state === 'environmentBlocked' || row.state === 'storageBudgetInsufficient' || row.state === 'environmentOutcomeUnknown' ? 'warning' : row.state === 'environmentReady' || row.state === 'storageMaterialReady' ? 'success' : row.state === 'environmentConfiguring' || row.state === 'storageMaterialDownloading' ? 'info' : 'neutral'}>{t(row.state)}</Tag></td>
  </tr>)}</tbody></table></div>
}
