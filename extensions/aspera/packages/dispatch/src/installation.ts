/** Durable installation budgets, immutable materials and authenticated SSH supervision. */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { importObservation, verifyServerStorage, redactObservation } from '@aspera/runtime'
import { observationLineSchema, observationSourceIdSchema } from '@aspera/experiments'
import type { ExperimentId, ExperimentServerId } from '@aspera/experiments'
import { copy, remote, shellQuote } from './transport.ts'
import { installPrivateFile } from './deploy.ts'
import type { DeploymentConfig } from './deploy.ts'
import type { SourceSnapshot } from './snapshot.ts'
import { verifySourceArchive } from './snapshot.ts'
import { cleanupLocalInputs } from './cleanup.ts'
import type { EnvironmentRequirements } from './environment.ts'
import type { PinnedDeployment } from './types.ts'
import { installationAttemptIdSchema, installationRoundIdSchema, installationSourceChangeIdSchema, installationPolicySchema, installationSourcesSchema, installationStatusSchema, preparationStoreSpec, sourceProbeSchema } from './installation-model.ts'
import type { InstallationAttemptId, InstallationSourceProbeId, InstallationPolicy, InstallationProgress, InstallationRound, InstallationSources, PreparationRecord } from './installation-model.ts'

/** Existing transport providers are reused by the remote installer and CPU fixtures. */
export interface InstallationDriver {
  remote: typeof remote
  copy: typeof copy
  installPrivateFile: typeof installPrivateFile
  verifyServerStorage: typeof verifyServerStorage
}
/** Session and tool association retained with installation observations. */
export interface InstallationInvocation { sessionId: SessionId; callId?: ToolCallId }
/** Active node operations exposed to the existing preparation Agent. */
export interface InstallationTools {
  inspect(signal: AbortSignal): Promise<object>
  probe(kind: 'npm' | 'nodeHeaders', url: string, signal: AbortSignal): Promise<object>
  switchSource(probeId: InstallationSourceProbeId, reason: string, signal: AbortSignal, invocation?: InstallationInvocation): Promise<object>
}
/** A managed installation failure is recoverable only through the original preparation Agent. */
export class InstallationDiagnostic extends Error {}

const pageSchema = z.object({ status: installationStatusSchema, lines: z.array(observationLineSchema.extend({ time: z.number() })), offset: z.number().int().nonnegative(), hasMore: z.boolean() })
const warningSchema = z.object({ level: z.enum(['warn', 'debug']), name: z.string().startsWith('pnpm:'), message: z.string().optional() })
const defaults: InstallationSources = { npm: 'https://registry.npmjs.org/', nodeHeaders: 'https://nodejs.org/download/release' }

/** Owns independent v1 journals; SSH disconnects never certify process exit. */
export class InstallationRecovery {
  private chain = Promise.resolve()
  private readonly active = new Map<string, Promise<void>>()
  private readonly root: string
  private constructor(private readonly store: Domain<typeof preparationStoreSpec>, private readonly policy: InstallationPolicy,
    private readonly driver: InstallationDriver, private readonly home: string) { this.root = resolve(home, 'aspera-preparation') }

  /** @param ctx - profile storage owner. @param policy - validated profile limits. @param driver - authenticated operations.
   * @param home - profile-owned private data directory. @returns the journal owner; its lifetime is closed by the fleet.
   */
  static async open(ctx: Context, policy: InstallationPolicy, driver: InstallationDriver, home = resolveDshHome()): Promise<InstallationRecovery> {
    return new InstallationRecovery(await ctx.storage.domain.open(preparationStoreSpec), installationPolicySchema.parse(policy), driver, home)
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.then(() => {}, () => {})
    return result
  }
  private get(id: ExperimentId): PreparationRecord {
    const record = this.store.table('installations').get(id)
    if (record === undefined) throw new Error('Installation policy was not pinned for this experiment')
    return structuredClone(record)
  }
  private async update(id: ExperimentId, apply: (record: PreparationRecord) => void): Promise<void> {
    await this.serial(async () => { const record = this.get(id); apply(record); await this.store.table('installations').put(id, record) })
  }
  private round(id: ExperimentId, serverId: ExperimentServerId): InstallationRound {
    const round = this.get(id).nodes.find(node => node.serverId === serverId)?.rounds.at(-1)
    if (round === undefined) throw new Error('Installation budget has not started')
    return round
  }
  private async changeRound(id: ExperimentId, serverId: ExperimentServerId, apply: (round: InstallationRound) => void): Promise<void> {
    await this.update(id, record => { const round = record.nodes.find(node => node.serverId === serverId)?.rounds.at(-1); if (!round) throw new Error('Installation node is absent'); apply(round) })
  }

  /** @param id - new experiment. @param serverIds - deduplicated selected nodes. */
  async pin(id: ExperimentId, serverIds: ExperimentServerId[]): Promise<void> {
    await this.serial(async () => {
      if (this.store.table('installations').get(id) !== undefined) return
      await this.store.table('installations').put(id, { experimentId: id, policy: this.policy,
        nodes: [...new Set(serverIds)].map(serverId => ({ serverId, rounds: [] })) })
    })
  }
  /** @param id - experiment. @returns whether a pre-existing policy and material journal can be resumed. */
  has(id: ExperimentId): boolean { return this.store.table('installations').get(id) !== undefined }
  /** @param id - experiment. @returns retained original material metadata, if available. */
  material(id: ExperimentId): PreparationRecord['material'] { return this.store.table('installations').get(id)?.material }
  /** @param ids - currently visible experiments. @returns public progress without private archive paths. */
  progress(ids: ExperimentId[]): InstallationProgress[] {
    return ids.flatMap(id => {
      const record = this.store.table('installations').get(id)
      return record?.nodes.flatMap(node => { const round = node.rounds.at(-1); return round ? [{ experimentId: id, serverId: node.serverId,
        policy: record.policy, digest: record.material?.digest, round, history: node.rounds.slice(0, -1) }] : [] }) ?? []
    })
  }
  /** @param id - experiment. @param serverId - fixed node. @param fresh - explicit user retry starts a new history entry. */
  async startBudget(id: ExperimentId, serverId: ExperimentServerId, fresh = false): Promise<void> {
    await this.update(id, record => {
      const node = record.nodes.find(node => node.serverId === serverId)
      if (!node) throw new Error('Installation node is outside the experiment')
      if (node.rounds.length && !fresh) return
      const previous = node.rounds.at(-1)
      node.rounds.push({ id: installationRoundIdSchema.parse(randomUUID()), startedAt: Date.now(), deadline: Date.now() + record.policy.installationTotalTimeoutMs,
        state: 'pending', attempts: [], sources: previous?.sources ?? defaults, probes: [], changes: [] })
    })
  }
  /** @param id - experiment. @param serverId - fixed node. @param signal - outer cancellation. @returns remaining total budget signal. */
  signal(id: ExperimentId, serverId: ExperimentServerId, signal: AbortSignal): AbortSignal {
    const remaining = this.round(id, serverId).deadline - Date.now()
    if (remaining <= 0) throw new InstallationDiagnostic('Installation total budget exhausted; use Retry preparation to start an explicit new recovery round')
    return AbortSignal.any([signal, AbortSignal.timeout(Math.min(remaining, 2_147_483_647))])
  }

  /** Retain an immutable archive before the temporary snapshot is disposed.
   * @param id - experiment. @param source - trusted generated material. @param requirements - original tool versions.
   */
  async retain(id: ExperimentId, source: SourceSnapshot, requirements: EnvironmentRequirements): Promise<void> {
    if (createHash('sha256').update(readFileSync(source.archive)).digest('hex') !== source.archiveHash) throw new Error('Original archive hash differs')
    const directory = resolve(this.root, 'materials'); mkdirSync(directory, { recursive: true, mode: 0o700 })
    const archive = resolve(directory, `${source.digest}-${source.archiveHash}.tar`)
    if (!existsSync(archive)) copyFileSync(source.archive, archive)
    if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== source.archiveHash) throw new Error('Retained archive integrity check failed')
    await this.update(id, record => {
      if (record.material && (record.material.digest !== source.digest || record.material.archiveHash !== source.archiveHash)) throw new Error('Experiment material cannot be replaced')
      record.material = { digest: source.digest, archiveHash: source.archiveHash, archive, requirements, retainedAt: Date.now() }
    })
  }
  /** Recover legacy material by its original content digest; current source code is never substituted.
   * @param id - experiment. @param digest - saved release. @param target - original node. @param password - private SSH credential.
   * @param signal - recovery cancellation. @returns original material requirements.
   */
  async recover(id: ExperimentId, digest: string, target: PinnedDeployment, password: string | undefined, signal: AbortSignal): Promise<EnvironmentRequirements> {
    const existing = this.material(id)
    if (existing) {
      if (existing.digest !== digest || !existsSync(existing.archive) || createHash('sha256').update(readFileSync(existing.archive)).digest('hex') !== existing.archiveHash) throw new Error('Original material is missing or has changed; recovery is blocked')
      return existing.requirements
    }
    const directory = resolve(this.root, 'recover', id); mkdirSync(directory, { recursive: true, mode: 0o700 })
    const archive = resolve(directory, `${digest}.tar`)
    const remoteRoot = target.storagePlacement?.namespaceRoot ?? target.remoteRoot
    if (!remoteRoot) throw new Error('Original archive location is absent')
    const remoteArchive = `${remoteRoot}/incoming/${digest}.tar`
    const size = Number(await this.driver.remote(target, `test -f ${shellQuote(remoteArchive)} && test ! -L ${shellQuote(remoteArchive)} && wc -c < ${shellQuote(remoteArchive)}`, signal, password))
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Original release archive is unavailable; recovery cannot use the current application release')
    const offset = existsSync(archive) ? statSync(archive).size : 0
    if (offset > size) throw new Error('Recovered archive size differs')
    for (let position = offset; position < size; position += 65536) {
      const encoded = await this.driver.remote(target, `dd if=${shellQuote(remoteArchive)} bs=1 skip=${position} count=${Math.min(65536, size - position)} 2>/dev/null | base64`, signal, password)
      const bytes = Buffer.from(encoded.trim(), 'base64')
      if (bytes.length !== Math.min(65536, size - position)) throw new Error('Original archive read was interrupted')
      appendFileSync(archive, bytes, { mode: 0o600 })
    }
    const requirements = await verifySourceArchive(archive, digest)
    const archiveHash = createHash('sha256').update(readFileSync(archive)).digest('hex')
    await this.retain(id, { digest, archiveHash, archive, directory, dispose: () => {} }, requirements)
    return requirements
  }
  private location(target: DeploymentConfig, id: ExperimentId, serverId: ExperimentServerId, attemptId: InstallationAttemptId) {
    const placement = target.storagePlacement
    if (!placement) throw new Error('Installation requires verified experiment storage')
    const directory = `${placement.workspaceRoot}/.aspera-installations/${id}/${serverId}/${attemptId}`
    return { directory, script: `${directory}/install-release.py`, config: `${directory}/config.json`,
      stage: `${placement.releaseRoot}.building-v1`, archive: `${placement.namespaceRoot}/incoming/${this.get(id).material!.digest}.tar`,
      cache: `${placement.namespaceRoot}/cache` }
  }
  private async operation(id: ExperimentId, serverId: ExperimentServerId, target: DeploymentConfig, password: string | undefined,
    operation: 'status' | 'stop' | 'probe', signal: AbortSignal, extra = '', reconcile = false): Promise<string> {
    const round = this.round(id, serverId)
    const attempt = round.attempts.at(-1)
    if (!attempt) throw new Error('Installation has no remote attempt')
    const location = this.location(target, id, serverId, attempt.id)
    const scope = operation === 'stop' || reconcile ? signal : this.signal(id, serverId, signal)
    return this.driver.remote(target, `python3 ${shellQuote(location.script)} ${operation} ${shellQuote(location.config)} ${extra}`, scope, password)
  }
  private async observe(id: ExperimentId, serverId: ExperimentServerId, target: DeploymentConfig, password: string | undefined,
    signal: AbortSignal, invocation?: InstallationInvocation, reconcile = false): Promise<InstallationRound> {
    const before = this.round(id, serverId)
    const attempt = before.attempts.at(-1)
    if (!attempt) return before
    const raw = await this.operation(id, serverId, target, password, 'status', signal, `--offset ${attempt.logOffset}`, reconcile)
    const page = pageSchema.parse(JSON.parse(raw))
    const material = this.get(id).material!
    if (page.status.attemptId !== attempt.id || page.status.experimentId !== id || page.status.serverId !== serverId
      || page.status.digest !== material.digest || page.status.archiveHash !== material.archiveHash || page.status.deadline !== before.deadline
      || page.offset < attempt.logOffset) throw new Error('Remote installation status belongs to another attempt')
    if (page.status.reason !== undefined) page.status.reason = redactObservation(page.status.reason, password ? [password] : [])
    if (invocation?.callId && !attempt.toolCallIds.includes(invocation.callId)) {
      attempt.toolCallIds.push(invocation.callId)
      await this.changeRound(id, serverId, round => { round.attempts.at(-1)!.toolCallIds = attempt.toolCallIds })
    }
    importObservation(resolve(this.home, 'aspera-observations', id), { version: 1,
      id: observationSourceIdSchema.parse(`installation-${attempt.id}`), experimentId: id, serverId,
      kind: 'preparation', phase: 'preparation', commandId: attempt.id, sessionId: attempt.sessionId, toolCallId: attempt.toolCallIds[0], label: 'Pinned release installation',
      createdAt: attempt.startedAt, streams: ['stdout', 'stderr'], complete: page.status.exitConfirmed && !page.hasMore,
    }, page.lines, password ? [password] : [])
    await this.changeRound(id, serverId, round => {
      const current = round.attempts.at(-1)!
      if (current.id !== attempt.id) throw new Error('Installation attempt changed during observation')
      current.status = page.status; current.logOffset = page.offset
      if (page.status.state === 'running') for (const line of page.lines) {
        let event: unknown
        try { event = JSON.parse(line.text) }
        catch (error) { if (error instanceof SyntaxError) continue; throw error }
        const warning = warningSchema.safeParse(event)
        if (!warning.success) continue
        if (warning.data.level === 'debug' && warning.data.name !== 'pnpm:request-retry') continue
        const reason = redactObservation(warning.data.message ?? line.text, password ? [password] : [])
        const code = warning.data.name.includes('request-retry') || /ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch.*retry/i.test(reason) ? 'download-retry'
          : /slow|low.*speed|request took|tarball.*speed/i.test(reason) ? 'download-slow' : undefined
        if (code && !current.notices.some(notice => notice.code === code)) current.notices.push({ code, seq: line.seq, time: line.time, reason, delivered: false })
      }
      round.state = page.status.state === 'completed' ? 'installing' : page.status.state === 'failed' ? 'diagnosing'
        : page.status.state === 'cancelled' ? 'cancelled' : page.status.state === 'unconfirmed' ? 'unconfirmed' : 'installing'
      round.detail = page.status.reason === undefined ? undefined : redactObservation(page.status.reason, password ? [password] : [])
    })
    if (page.hasMore && page.status.exitConfirmed) return this.observe(id, serverId, target, password, signal, invocation, reconcile)
    return this.round(id, serverId)
  }

  /** Install or resume the same fixed material; restarting consumes a retry only after exit confirmation.
   * @param id - experiment. @param serverId - fixed node. @param target - prepared storage and tool paths.
   * @param password - private credential. @param signal - local read cancellation. @param invocation - triggering Agent Session and verification.
   * @param started - source-change receipt recorded when the new attempt is observed.
   */
  ensure(id: ExperimentId, serverId: ExperimentServerId, target: DeploymentConfig, password: string | undefined,
    signal: AbortSignal, invocation?: InstallationInvocation, started?: () => Promise<void>): Promise<void> {
    const key = `${id}/${serverId}`
    const existing = this.active.get(key)
    if (existing) return existing
    const operation = this.install(id, serverId, target, password, signal, invocation, started).finally(() => {
      if (this.active.get(key) === operation) this.active.delete(key)
    })
    this.active.set(key, operation)
    return operation
  }
  private async install(id: ExperimentId, serverId: ExperimentServerId, target: DeploymentConfig, password: string | undefined,
    signal: AbortSignal, invocation?: InstallationInvocation, started?: () => Promise<void>): Promise<void> {
    const lifetime = this.signal(id, serverId, signal)
    let round = this.round(id, serverId)
    if (round.state === 'verified') return
    if (round.attempts.length) round = await this.observe(id, serverId, target, password, lifetime, invocation)
    const previous = round.attempts.at(-1)
    if (previous?.status?.state === 'completed' && previous.status.exitConfirmed) return
    if (previous?.status?.state === 'unconfirmed') throw new InstallationDiagnostic(`Installation exit remains unconfirmed at ${previous.directory}; duplicate installation is blocked`)
    if (!previous || previous.status?.exitConfirmed) {
      // A fresh user budget still has to reconcile the previous round's processes.
      const history = this.get(id).nodes.find(node => node.serverId === serverId)!.rounds.slice(0, -1)
      if (history.some(entry => entry.attempts.some(attempt => !attempt.status?.exitConfirmed))) throw new InstallationDiagnostic('Previous installation exit is unconfirmed; reconcile it before starting a new budget')
      if (round.attempts.length > this.get(id).policy.installationMaxRetries) {
        await this.changeRound(id, serverId, value => { value.state = 'failed'; value.detail = 'Installation retry budget exhausted' })
        throw new InstallationDiagnostic('Installation retry budget exhausted; previous attempts and logs are retained')
      }
      const material = this.get(id).material
      if (!material) throw new Error('Original installation material is absent')
      if (!target.storagePlacement) throw new Error('Installation storage is absent')
      await this.driver.verifyServerStorage(target, target.storagePlacement, password, lifetime, statSync(material.archive).size)
      const attemptId = installationAttemptIdSchema.parse(randomUUID())
      const location = this.location(target, id, serverId, attemptId)
      await this.driver.remote(target, `umask 077; mkdir -p ${[location.directory, location.archive.slice(0, location.archive.lastIndexOf('/')), target.storagePlacement.releaseRoot.slice(0, target.storagePlacement.releaseRoot.lastIndexOf('/')),
        target.storagePlacement.workspaceRoot, target.remoteRoot + '/secrets', target.remoteRoot + '/state', target.remoteRoot + '/logs', target.remoteRoot + '/tools', target.remoteRoot + '/probe-outside'].map(shellQuote).join(' ')}`, lifetime, password)
      const cached = await this.driver.remote(target, `if [ -f ${shellQuote(location.archive)} ] && test ! -L ${shellQuote(location.archive)}; then sha256sum ${shellQuote(location.archive)} | cut -d ' ' -f 1; fi`, lifetime, password)
      if (cached.trim() !== material.archiveHash) await this.driver.copy(target, material.archive, location.archive, lifetime, password)
      await this.driver.installPrivateFile(target, location.script, readFileSync(fileURLToPath(new URL('../scripts/install-release.py', import.meta.url)), 'utf8'), lifetime, password)
      await this.driver.installPrivateFile(target, location.config, JSON.stringify({ version: 1, experimentId: id, serverId, attemptId,
        digest: material.digest, archiveHash: material.archiveHash, ...location, release: target.storagePlacement.releaseRoot,
        deadline: round.deadline, idleTimeoutMs: this.get(id).policy.installationIdleTimeoutMs, sources: round.sources,
        pathEntries: target.pathEntries ?? [], sampleIntervalMs: target.controlPollIntervalMs }), lifetime, password)
      await this.changeRound(id, serverId, value => { value.state = 'installing'; value.attempts.push({ id: attemptId,
        directory: location.directory, sources: value.sources, startedAt: Date.now(), logOffset: 0,
        sessionId: invocation?.sessionId, toolCallIds: invocation?.callId === undefined ? [] : [invocation.callId], notices: [] }) })
      // Save before launch: an interrupted SSH reply is reconciled by identity instead of launching again.
      try { await this.driver.remote(target, `python3 ${shellQuote(location.script)} launch ${shellQuote(location.config)}`, lifetime, password) }
      catch (error) { lifetime.throwIfAborted(); throw new InstallationDiagnostic(`Installer launch reply is unavailable; inspect its saved identity before any restart. ${redactObservation(String(error), password ? [password] : [])}`) }
    }
    for (;;) {
      lifetime.throwIfAborted()
      try { round = await this.observe(id, serverId, target, password, lifetime, invocation) }
      catch (error) {
        lifetime.throwIfAborted()
        await this.changeRound(id, serverId, value => { value.state = 'unconfirmed'; value.detail = redactObservation(String(error), password ? [password] : []) })
        throw new InstallationDiagnostic(`Installation connection interrupted; inspect the original attempt before retrying. ${redactObservation(String(error), password ? [password] : [])}`)
      }
      const attempt = round.attempts.at(-1)!
      if (started && (attempt.status?.state === 'running' || attempt.status?.state === 'completed')) { await started(); started = undefined }
      if (attempt.status?.state === 'completed' && attempt.status.exitConfirmed) return
      if (attempt.status?.exitConfirmed || attempt.status?.state === 'unconfirmed') throw new InstallationDiagnostic(JSON.stringify({ installation: round, logSource: `installation-${attempt.id}` }))
      const notices = attempt.notices.filter(notice => !notice.delivered)
      if (notices.length) {
        await this.changeRound(id, serverId, value => { value.state = 'diagnosing'; value.detail = notices.map(notice => notice.reason).join('\n');
          for (const notice of value.attempts.at(-1)!.notices) notice.delivered = true })
        throw new InstallationDiagnostic(JSON.stringify({ installation: this.round(id, serverId), logSource: `installation-${attempt.id}`,
          action: 'The managed installer remains running. Diagnose the source warning; verify again to continue waiting, or probe and switch sources within the existing budget.' }))
      }
      await delay(Math.min(target.controlPollIntervalMs, Math.max(1, round.deadline - Date.now())), undefined, { signal: lifetime })
    }
  }
  /** @param id - experiment. @param serverId - node. Mark ready only after deterministic deployment and environment checks. */
  async verified(id: ExperimentId, serverId: ExperimentServerId): Promise<void> {
    if (Date.now() > this.round(id, serverId).deadline) throw new InstallationDiagnostic('Installation total budget exhausted during verification')
    await this.changeRound(id, serverId, round => { round.state = 'verified'; round.finishedAt = Date.now(); round.detail = undefined })
  }
  /** @param id - experiment. @param serverId - active node. @param target - fixed connection. @param password - private credential.
   * @param sessionId - local dispatch Session. @returns Agent tools that share the same budget, probes and restart limit.
   */
  tools(id: ExperimentId, serverId: ExperimentServerId, target: DeploymentConfig, password: string | undefined, sessionId?: SessionId): InstallationTools {
    return {
      inspect: async signal => {
        await this.observe(id, serverId, target, password, signal, sessionId === undefined ? undefined : { sessionId })
        await this.changeRound(id, serverId, round => { for (const notice of round.attempts.at(-1)?.notices ?? []) notice.delivered = true })
        return this.round(id, serverId)
      },
      probe: async (kind, url, signal) => {
        const sources = installationSourcesSchema.parse({ ...this.round(id, serverId).sources, [kind]: url })
        const value = JSON.parse(await this.operation(id, serverId, target, password, 'probe', signal, `--kind ${kind} --url ${shellQuote(sources[kind])}`))
        const probe = sourceProbeSchema.parse({ ...value, id: randomUUID(), kind, url: sources[kind], checkedAt: Date.now() })
        probe.detail = redactObservation(probe.detail, password ? [password] : [])
        await this.changeRound(id, serverId, round => { round.probes.push(probe) })
        return probe
      },
      switchSource: async (probeId, reason, signal, invocation) => {
        if (!reason.trim()) throw new Error('Source switch requires an actual diagnostic reason')
        let round = this.round(id, serverId)
        const probe = round.probes.find(value => value.id === probeId)
        if (!probe?.available) throw new Error('Source must pass a probe in the current recovery round')
        if (round.sources[probe.kind] === probe.url) return round
        const attempt = round.attempts.at(-1)
        if (!attempt) throw new Error('Source switching requires a registered installation')
        await this.stop(id, serverId, target, password, signal)
        round = this.round(id, serverId)
        if (!round.attempts.at(-1)?.status?.exitConfirmed) throw new InstallationDiagnostic('Source switch is blocked until the previous installation exits')
        if (round.attempts.length > this.get(id).policy.installationMaxRetries) throw new InstallationDiagnostic('Source switching cannot reset the retry budget')
        await this.changeRound(id, serverId, value => { value.sources = { ...value.sources, [probe.kind]: probe.url } })
        const changeId = installationSourceChangeIdSchema.parse(randomUUID())
        await this.changeRound(id, serverId, value => { value.changes.push({ id: changeId, attemptId: attempt.id,
          previous: round.sources, next: value.sources, reason: redactObservation(reason, password ? [password] : []),
          probe, changedAt: Date.now(), applied: false }) })
        await this.ensure(id, serverId, target, password, signal, invocation ?? (sessionId === undefined ? undefined : { sessionId }), async () => {
          await this.changeRound(id, serverId, value => { const change = value.changes.find(entry => entry.id === changeId)!;
            change.applied = true; change.attemptId = value.attempts.at(-1)!.id; change.changedAt = Date.now() })
        })
        return this.round(id, serverId)
      },
    }
  }
  /** Stop only the registered installer; an absent response retains its ownership.
   * @param id - experiment. @param serverId - node. @param target - pinned connection. @param password - private credential.
   * @param signal - bounded cancellation command. @returns whether all observed attempt processes exited.
   */
  async stop(id: ExperimentId, serverId: ExperimentServerId, target: DeploymentConfig, password: string | undefined, signal: AbortSignal): Promise<boolean> {
    const round = this.round(id, serverId)
    if (!round.attempts.length) return true
    if (round.attempts.at(-1)?.status?.exitConfirmed) return true
    await this.operation(id, serverId, target, password, 'stop', signal)
    for (;;) {
      signal.throwIfAborted()
      // Exit reconciliation is still allowed after total-budget exhaustion.
      const observed = await this.observe(id, serverId, target, password, signal, undefined, true)
      const status = observed.attempts.at(-1)!.status!
      await this.changeRound(id, serverId, value => { value.state = status.exitConfirmed ? 'cancelled' : 'unconfirmed'; if (status.exitConfirmed) value.finishedAt = Date.now() })
      if (status.exitConfirmed) return true
      if (status.state === 'unconfirmed') return false
      await delay(target.controlPollIntervalMs, undefined, { signal })
    }
  }
  /** @param id - experiment. @returns nodes whose last observed installation has no confirmed exit. */
  pending(id: ExperimentId): ExperimentServerId[] {
    return this.store.table('installations').get(id)?.nodes.filter(node => node.rounds.some(round => round.attempts.some(attempt => !attempt.status?.exitConfirmed))).map(node => node.serverId) ?? []
  }
  /** @param id - experiment. @param sessionId - local dispatch Session. @param callId - recorded tool call.
   * @returns the supervised installation actually observed by that call.
   */
  commandForCall(id: ExperimentId, sessionId: string, callId: string): { serverId: ExperimentServerId; commandId: InstallationAttemptId } | undefined {
    const nodes = this.store.table('installations').get(id)?.nodes ?? []
    for (const node of nodes) for (const round of node.rounds) for (const attempt of round.attempts) {
      if (attempt.sessionId === sessionId && attempt.toolCallIds.some(value => value === callId)) return { serverId: node.serverId, commandId: attempt.id }
    }
    return undefined
  }
  /** Read-only reconciliation remains available after an expired budget.
   * @param id - experiment. @param serverId - node. @param target - pinned connection. @param password - private credential.
   * @param signal - bounded read. @returns whether the saved installer has a confirmed exit.
   */
  async reconcile(id: ExperimentId, serverId: ExperimentServerId, target: DeploymentConfig, password: string | undefined, signal: AbortSignal): Promise<boolean> {
    if (!this.pending(id).includes(serverId)) return true
    const round = await this.observe(id, serverId, target, password, signal, undefined, true)
    return round.attempts.at(-1)?.status?.exitConfirmed === true
  }
  /** Retain the failure and outstanding process ownership when an Agent or budget ends.
   * @param id - experiment. @param detail - final diagnostic without credentials.
   */
  async failed(id: ExperimentId, detail: string): Promise<void> {
    if (!this.has(id)) return
    await this.update(id, record => { for (const node of record.nodes) {
      const round = node.rounds.at(-1)
      if (!round || round.state === 'verified') continue
      round.state = round.attempts.some(attempt => !attempt.status?.exitConfirmed) ? 'unconfirmed' : 'failed'
      round.detail = redactObservation(detail)
      round.finishedAt = Date.now()
    } })
  }
  /** Remove a settled experiment's private journal and unreferenced original archive.
   * @param id - deleted experiment. Unknown installer exits retain both records and material.
   */
  async forget(id: ExperimentId): Promise<void> {
    await this.serial(async () => {
      if (!this.has(id) || this.pending(id).length > 0) return
      const material = this.material(id)
      if (material && ![...this.store.table('installations').entries()].some(([otherId, record]) => otherId !== id && record.material?.archive === material.archive)) {
        const expected = resolve(this.root, 'materials', `${material.digest}-${material.archiveHash}.tar`)
        if (material.archive !== expected) throw new Error('Original material path is outside the private archive catalog')
        if (existsSync(expected)) unlinkSync(expected)
      }
      cleanupLocalInputs(resolve(this.root, 'recover'), id)
      await this.store.table('installations').delete(id)
    })
  }
  /** Flush the journal after local readers and Agent operations have stopped. */
  async close(): Promise<void> { await this.chain; await this.store.close() }
}
