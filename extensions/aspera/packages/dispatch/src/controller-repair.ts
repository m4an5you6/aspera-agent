/** Preparation-owned controller restarts retain receipts across cancellation and application recovery. */
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { z } from 'zod'
import { controllerStatusSchema, controllerRepairIdSchema, experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import type { ControllerStatus, ExperimentId, ExperimentServerId } from '@aspera/experiments'
import { ControllerDiagnostic, verifyController } from './cluster-deploy.ts'
import type { FleetDriver } from './fleet.ts'
import type { DeploymentConfig, PreparedEnvironment } from './deploy.ts'
import { shellQuote } from './transport.ts'

/** Only the active preparation step can inspect or restart its assigned role. */
export interface ControllerRepairTools {
  /** @param signal - probe lifetime. @returns current public differences and saved attempts. */
  inspect(signal: AbortSignal): Promise<object>
  /** @param signal - mutation lifetime. @param pending - durable operation ownership. @returns repair facts requiring independent revalidation. */
  repair(signal: AbortSignal, pending: (directory: string) => Promise<void>): Promise<object>
  /** @param directory - original operation receipt. @param signal - recovery lifetime. @returns confirmed recovery or an unresolved-ownership error. */
  reconcile(directory: string, signal: AbortSignal): Promise<void>
}
const attemptSchema = z.object({ id: controllerRepairIdSchema, expected: controllerStatusSchema,
  phase: z.enum(['beginning', 'stopping', 'starting', 'completed', 'failed', 'unconfirmed']),
  directory: z.string().startsWith('/'), startedAt: z.number().int(), detail: z.string().optional() }).strict()
const receiptSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  role: z.enum(['node', 'coordinator']), deploymentId: z.string(), maxAttempts: z.number().int().nonnegative(), attempts: z.array(attemptSchema),
  acceptance: z.object({ checkedAt: z.number().int().nonnegative(), controller: controllerStatusSchema }).strict().optional() }).strict()
type Receipt = z.infer<typeof receiptSchema>
/** Profile-owned retry limit is pinned by the independent repair journal. */
export const controllerRepairPolicySchema = z.object({ maxAttempts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(2) }).strict()

/** The local receipt contains process identity and public diagnostics, never SSH or control credentials. */
export class ControllerRepair implements ControllerRepairTools {
  private readonly path: string
  private readonly remoteDirectory: string
  private receipt: Receipt
  prepared: PreparedEnvironment
  acceptance: ControllerStatus | undefined

  /** @param input - program-selected server, role, immutable release and operation limit. @param driver - existing authenticated providers. */
  constructor(private readonly input: { experimentId: ExperimentId; serverId: ExperimentServerId; role: 'node' | 'coordinator';
    target: DeploymentConfig; prepared: PreparedEnvironment; token: string; password?: string; maxAttempts: number }, private readonly driver: FleetDriver) {
    this.prepared = input.prepared
    const runRoot = input.target.storagePlacement?.runRoot ?? `${input.target.remoteRoot}/runs/${input.experimentId}`
    this.remoteDirectory = `${runRoot}/controller-repairs/${input.role}`
    this.path = resolve(resolveDshHome(), 'aspera-controller-repairs', input.experimentId, `${input.serverId}-${input.role}.v1.json`)
    if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink()) throw new Error('Controller repair receipt cannot be a symbolic link')
    this.receipt = existsSync(this.path) ? receiptSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      : { version: 1, experimentId: input.experimentId, serverId: input.serverId, role: input.role, deploymentId: input.prepared.deploymentId, maxAttempts: input.maxAttempts, attempts: [] }
    if (this.receipt.experimentId !== input.experimentId || this.receipt.serverId !== input.serverId
      || this.receipt.role !== input.role || this.receipt.deploymentId !== input.prepared.deploymentId) throw new Error('Controller repair receipt has another owner or release')
    for (const attempt of this.receipt.attempts) if (attempt.expected.root !== input.target.remoteRoot || attempt.expected.role !== input.role
      || attempt.directory !== `${this.remoteDirectory}/${attempt.id}`) throw new Error('Controller repair attempt is outside its saved server or experiment')
  }
  private save(): void {
    const parent = resolve(this.path, '..')
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    if (lstatSync(parent).isSymbolicLink()) throw new Error('Controller repair directory cannot be a symbolic link')
    const incoming = `${this.path}.${randomUUID()}.incoming`
    writeFileSync(incoming, JSON.stringify(this.receipt) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(incoming, this.path)
  }
  private target() { return { ...this.input.target, remotePort: this.input.target.remotePort + (this.input.role === 'coordinator' ? 1 : 0) } }
  private async status(signal: AbortSignal): Promise<ControllerStatus> {
    return this.driver.inspectController(this.input.target, this.input.role, this.input.token, this.input.password, signal)
  }
  /** @param signal - inspection lifetime. @returns current differences and saved repair status. */
  async inspect(signal: AbortSignal): Promise<object> {
    try {
      const status = await this.status(signal)
      try { verifyController(status, this.input.target, this.prepared, this.input.role); return { ready: true, controller: status, attempts: this.receipt.attempts } }
      catch (error) { if (error instanceof ControllerDiagnostic) return { ready: false, diagnostic: error.diagnostic, attempts: this.receipt.attempts }; throw error }
    } catch (error) { if (error instanceof ControllerDiagnostic) return { ready: false, diagnostic: error.diagnostic, attempts: this.receipt.attempts }; throw error }
  }
  /** @param signal - verification lifetime. @param pathEntries - verified executable directories. @returns current accepted deployment after program-owned controller verification. */
  async verify(signal: AbortSignal, pathEntries?: string[]): Promise<PreparedEnvironment> {
    if (pathEntries !== undefined) this.input.target = { ...this.input.target, pathEntries }
    this.prepared = await this.driver.prepareClusterServer(this.input.target, { digest: this.prepared.deploymentId, reuse: true }, this.input.password, signal)
    await this.driver.ensureClusterRole(this.input.target, this.prepared, this.input.role, this.input.token, this.input.password, signal)
    this.acceptance = verifyController(await this.status(signal), this.input.target, this.prepared, this.input.role)
    this.receipt.acceptance = { checkedAt: Date.now(), controller: this.acceptance }; this.save()
    this.prepared = { ...this.prepared, controller: this.acceptance }
    return this.prepared
  }
  /** @param signal - final handover lifetime. @returns whether the accepted process and GPU facts are still current. */
  async verifyAcceptance(signal: AbortSignal): Promise<void> {
    const current = verifyController(await this.status(signal), this.input.target, this.prepared, this.input.role)
    if (this.acceptance === undefined || current.bootId !== this.acceptance.bootId || current.policyDigest !== this.acceptance.policyDigest) {
      throw new Error('Controller changed after acceptance; repeat preparation before handover')
    }
  }
  private async finish(attempt: Receipt['attempts'][number], signal: AbortSignal): Promise<void> {
    this.acceptance = verifyController(await this.status(signal), this.input.target, this.prepared, this.input.role)
    if (this.acceptance.bootId === attempt.expected.bootId) throw new Error('Original controller was not replaced by this repair')
    await this.driver.remote(this.input.target, `printf '0\\n' > ${shellQuote(attempt.directory + '/exited')}`, signal, this.input.password)
    attempt.phase = 'completed'; delete attempt.detail; this.save()
  }
  /** @param directory - saved command ownership. @param signal - recovery lifetime. @returns confirmation before another mutation can begin. */
  async reconcile(directory: string, signal: AbortSignal): Promise<void> {
    const attempt = this.receipt.attempts.find(value => value.directory === directory)
    if (attempt === undefined) throw new Error('Pending controller repair belongs to another operation')
    if (attempt.phase === 'completed' || attempt.phase === 'failed') return
    const receipt = await this.driver.remote(this.input.target, `if [ -f ${shellQuote(directory + '/exited')} ]; then cat ${shellQuote(directory + '/exited')}; else printf unknown; fi`, signal, this.input.password)
    if (receipt.trim() === '1') { attempt.phase = 'failed'; this.save(); return }
    this.prepared = await this.driver.prepareClusterServer(this.input.target, { digest: this.prepared.deploymentId, reuse: true }, this.input.password, signal)
    let current: ControllerStatus | undefined
    try { current = await this.status(signal) } catch (error) { signal.throwIfAborted(); if (error instanceof ControllerDiagnostic) throw error }
    if (current !== undefined && current.bootId !== attempt.expected.bootId) { await this.finish(attempt, signal); return }
    const exited = await this.driver.remote(this.input.target, `if [ -f ${shellQuote(directory + '/stopped.json')} ]; then cat ${shellQuote(directory + '/stopped.json')}; else printf '{}'; fi`, signal, this.input.password)
    const stop = z.object({ operationId: z.literal(attempt.id), exited: z.literal(true) }).safeParse(JSON.parse(exited))
    if (!stop.success || current !== undefined) throw new Error(`Controller repair outcome remains unconfirmed at ${directory}; its command will not be rerun`)
    attempt.phase = 'starting'; this.save()
    await this.driver.ensureClusterRole(this.input.target, this.prepared, this.input.role, this.input.token, this.input.password, signal)
    await this.finish(attempt, signal)
  }
  /** @param signal - repair lifetime. @param pending - durable ownership saved before any remote maintenance operation. @returns verified restart facts, requiring subsequent Agent-requested environment verification. */
  async repair(signal: AbortSignal, pending: (directory: string) => Promise<void>): Promise<object> {
    const last = this.receipt.attempts.at(-1)
    if (last !== undefined && !['completed', 'failed'].includes(last.phase)) { await this.reconcile(last.directory, signal); return { repaired: true, operationId: last.id, verificationRequired: true } }
    this.prepared = await this.driver.prepareClusterServer(this.input.target, { digest: this.prepared.deploymentId, reuse: true }, this.input.password, signal)
    const expected = await this.status(signal)
    try { verifyController(expected, this.input.target, this.prepared, this.input.role); return { repaired: false, ready: true, verificationRequired: true } }
    catch (error) { if (!(error instanceof ControllerDiagnostic)) throw error }
    if (expected.legacy) throw new ControllerDiagnostic({ code: 'unknown', role: this.input.role, detail: 'The original controller has no safe maintenance operation; confirm task release and stop it before retrying. Its original release is preserved.' })
    if (Object.values(expected.occupied).some(ids => ids.length !== 0)) throw new ControllerDiagnostic({ code: 'occupied', role: this.input.role, controller: expected, detail: 'Tasks, commands or inference services have not confirmed release' })
    if (expected.root !== this.input.target.remoteRoot || expected.role !== this.input.role || expected.processStart === undefined || expected.hostBootId === undefined) throw new Error('Controller process identity cannot authorize a safe restart')
    if (expected.maintenance !== undefined) throw new Error('Another maintenance operation owns this controller')
    if (this.receipt.attempts.length >= this.receipt.maxAttempts) throw new Error('Controller repair attempt limit reached; inspect the saved receipts')
    const id = controllerRepairIdSchema.parse(randomUUID()); const directory = `${this.remoteDirectory}/${id}`
    const attempt: Receipt['attempts'][number] = { id, expected, phase: 'beginning', directory, startedAt: Date.now() }
    this.receipt.attempts.push(attempt); this.save(); await pending(directory)
    try {
      await this.driver.remote(this.input.target, `umask 077\nmkdir -p ${shellQuote(directory)}`, signal, this.input.password)
      const route = this.input.role === 'node' ? '/aspera/v1/node/maintenance-begin' : '/aspera/v1/maintenance-begin'
      const response = await this.driver.request(this.target(), this.input.token, route, 'POST',
        { operationId: id, bootId: expected.bootId, policyDigest: expected.policyDigest }, signal, this.input.password)
      if (response.status !== 200) {
        await this.driver.remote(this.input.target, `printf '1\\n' > ${shellQuote(directory + '/exited')}`, signal, this.input.password)
        attempt.phase = 'failed'; this.save(); throw new Error(`Controller refused maintenance: ${JSON.stringify(response.value)}`)
      }
      z.object({ maintenance: z.literal(id), bootId: z.literal(expected.bootId), policyDigest: z.literal(expected.policyDigest) }).parse(response.value)
      attempt.phase = 'stopping'; this.save()
      const stopScript = `import json,os,pathlib,select,signal,socket,time
pid=${expected.pid}; expected_start=${JSON.stringify(expected.processStart)}; expected_boot=${JSON.stringify(expected.hostBootId)}
directory=pathlib.Path(${JSON.stringify(directory)})
if pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()!=expected_boot: raise RuntimeError('Host boot identity changed')
fd=os.pidfd_open(pid)
base=pathlib.Path('/proc')/str(pid)
if (base/'stat').read_text().rsplit(')',1)[1].split()[19]!=expected_start: raise RuntimeError('Controller process identity changed')
command=(base/'cmdline').read_bytes().split(b'\\0')
if b'--profile' not in command or command[command.index(b'--profile')+1]!=b'aspera-worker': raise RuntimeError('Controller is not the owned worker profile')
entries=dict(item.split(b'=',1) for item in (base/'environ').read_bytes().split(b'\\0') if b'=' in item)
for key,value in {'DSH_CLUSTER_ROOT':${JSON.stringify(expected.root)},'DSH_EXPERIMENT_ROLE':${JSON.stringify(expected.role)},'DSH_EXPERIMENT_DEPLOYMENT_ID':${JSON.stringify(expected.deploymentId)}}.items():
 if entries.get(key.encode(),b'').decode()!=value: raise RuntimeError('Controller configuration identity changed')
signal.pidfd_send_signal(fd,signal.SIGTERM)
if not select.select([fd],[],[],${this.input.target.toolTimeoutMs / 1000})[0]: raise RuntimeError('Controller exit is unconfirmed')
os.close(fd)
client=socket.socket(); client.settimeout(1)
if client.connect_ex(('127.0.0.1',${this.target().remotePort}))==0: raise RuntimeError('Control port is still occupied')
client.close()
pid_file=pathlib.Path(${JSON.stringify(this.input.target.remoteRoot + '/state/' + this.input.role + '.pid')})
if pid_file.exists():
 if pid_file.read_text().strip()!=str(pid): raise RuntimeError('Controller PID file belongs to another process')
 pid_file.unlink()
(directory/'stopped.json').write_text(json.dumps({'operationId':${JSON.stringify(id)},'exited':True}))
`
      await this.driver.remote(this.input.target, `python3 -c ${shellQuote(stopScript)}`, signal, this.input.password)
      attempt.phase = 'starting'; this.save()
      await this.driver.ensureClusterRole(this.input.target, this.prepared, this.input.role, this.input.token, this.input.password, signal)
      await this.finish(attempt, signal)
      return { repaired: true, operationId: id, controller: this.acceptance, verificationRequired: true }
    } catch (error) {
      if (attempt.phase !== 'failed') { attempt.phase = 'unconfirmed'; attempt.detail = String(error); this.save() }
      throw error
    }
  }
}
