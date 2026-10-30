/** Durable preparation command supervision and SSH-independent log recovery. */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { importObservation, observationSources } from '@aspera/runtime'
import { observationLineSchema } from '@aspera/experiments'
import type { ObservationSource } from '@aspera/experiments'
import { shellQuote } from './transport.ts'
import type { remote, remoteResult, RemoteCommandResult, Target } from './transport.ts'

/** Read failures share one recovery interval; command retries never reset the remote deadline. */
export const preparationCommandPolicySchema = z.object({
  pollIntervalMs: z.number().int().positive().max(10000).default(1000),
  readTimeoutMs: z.number().int().positive().max(2_147_483_647).default(30000),
  recoveryTimeoutMs: z.number().int().positive().max(2_147_483_647).default(60000),
  stopGraceMs: z.number().int().positive().max(60000).default(5000),
})
/** Resolved polling and process-exit bounds owned by the local Host. */
export type PreparationCommandPolicy = z.infer<typeof preparationCommandPolicySchema>

const pageSchema = z.object({ status: z.object({ version: z.literal(1), experimentId: z.string(), serverId: z.string(), commandId: z.string(),
  sessionId: z.string(), toolCallId: z.string(),
  exitCode: z.number().int().nullable(), exitConfirmed: z.boolean(), timedOut: z.boolean(), cancelled: z.boolean(), signal: z.string().nullable(),
  deadline: z.number().optional(), startedAt: z.number().optional(), finishedAt: z.number().optional(), reason: z.string().optional(),
  supervisorMissing: z.boolean().optional(),
}), lines: z.array(observationLineSchema.extend({ time: z.number() })), offset: z.number().int().nonnegative(), hasMore: z.boolean() })

/** Program-owned paths and identities for one immutable command invocation. */
export interface PreparationInvocation {
  directory: string
  cacheDirectory: string
  command: string
  source: ObservationSource
  timeoutMs: number
  policy: PreparationCommandPolicy
  python?: string
  uvVersion?: string
  uvPath?: string
}

/** The existing authenticated SSH providers retain ownership of credentials. */
export interface PreparationCommandDriver { remote: typeof remote; remoteResult: typeof remoteResult }

/** Confirmed legacy exits retain their original transport output until their logs can be recovered. */
export interface RecoveredPreparationCommand extends RemoteCommandResult { supervised: boolean }

/**
 * Generate an exclusive request and a detached supervisor, without exposing credentials to the command.
 * @param input - immutable invocation and resolved limits.
 * @returns foreground SSH reader; remote logs and supervision survive its disconnection.
 */
export function preparationCommandScript(input: PreparationInvocation): string {
  const directory = shellQuote(input.directory)
  const request = { version: 1, experimentId: input.source.experimentId, serverId: input.source.serverId,
    commandId: input.source.commandId, sessionId: input.source.sessionId, toolCallId: input.source.toolCallId,
    command: input.command, cacheDirectory: input.cacheDirectory, timeoutMs: input.timeoutMs,
    pollIntervalMs: input.policy.pollIntervalMs, stopGraceMs: input.policy.stopGraceMs, readTimeoutMs: input.policy.readTimeoutMs,
    uvVersion: input.uvVersion, uvPath: input.uvPath }
  const python = input.python === undefined ? undefined : shellQuote(input.python)
  // The shell-only path bootstraps Python itself; its logs remain independent of the SSH pipe.
  const execute = python === undefined ? `export ASPERA_PREPARATION_COMMAND_DIRECTORY=${directory}
export ASPERA_PREPARATION_SESSION_ID=${shellQuote(input.source.sessionId ?? '')}
export ASPERA_PREPARATION_TOOL_CALL_ID=${shellQuote(input.source.toolCallId ?? '')}
export ASPERA_PREPARATION_CACHE_DIRECTORY=${shellQuote(input.cacheDirectory)}
export ASPERA_PREPARATION_REMAINING_MS=${input.timeoutMs}
printf shell > ${directory}/shell-only
timeout -k ${Math.max(0.001, input.policy.stopGraceMs / 1000)}s ${Math.max(0.001, input.timeoutMs / 1000)}s sh -c ${shellQuote(input.command)} > ${directory}/stdout.log 2> ${directory}/stderr.log
status=$?
if [ ! -f ${directory}/sandbox-repair-unconfirmed ]; then printf '%s\\n' "$status" > ${directory}/exited; fi
cat ${directory}/stdout.log
cat ${directory}/stderr.log >&2
exit "$status"` : `printf '%s\\n' ${shellQuote(readFileSync(new URL('../scripts/preparation-command.py', import.meta.url), 'utf8'))} > ${directory}/command.py
${python} -B -I ${directory}/command.py start ${directory}`
  return `umask 077
mkdir -p ${shellQuote(input.directory.slice(0, input.directory.lastIndexOf('/')))} ${shellQuote(input.cacheDirectory)}
mkdir ${directory} || exit 1
printf '%s\\n' ${shellQuote(JSON.stringify(request))} > ${directory}/request.v1.json
${execute}`
}

/**
 * Stream a complete supervised launcher without placing its source in SSH arguments.
 * @param input - original invocation and a verified Python path when available.
 * @returns short command plus UTF-8 input, or the shell-only bootstrap before Python exists.
 */
export function preparationCommandTransfer(input: PreparationInvocation): { script: string; input?: string } {
  const payload = preparationCommandScript(input)
  if (input.python === undefined) return { script: payload }
  const loader = `import hashlib,os,pathlib,subprocess,sys,tempfile
data=sys.stdin.buffer.read(int(sys.argv[1])+1)
if len(data)!=int(sys.argv[1]) or hashlib.sha256(data).hexdigest()!=sys.argv[2]:
 raise RuntimeError('Preparation launcher input is incomplete or changed; no command was started')
parent=pathlib.Path(sys.argv[3])
if not parent.is_absolute() or any(item.is_symlink() for item in (parent,*parent.parents)):
 raise RuntimeError('Preparation launcher directory is outside its owned path')
parent.mkdir(parents=True,exist_ok=True,mode=0o700)
status=parent.stat()
if status.st_uid!=os.geteuid() or status.st_mode&0o022:
 raise RuntimeError('Preparation launcher directory is not private to the SSH account')
with tempfile.TemporaryFile(dir=parent) as source:
 source.write(data);source.flush();source.seek(0)
 environment=dict(os.environ);environment.pop('BASH_ENV',None);environment.pop('ENV',None)
 result=subprocess.run(['/bin/bash','/proc/self/fd/'+str(source.fileno())],stdin=subprocess.DEVNULL,pass_fds=(source.fileno(),),env=environment)
sys.exit(result.returncode)`
  return { script: `${shellQuote(input.python)} -B -I -c ${shellQuote(loader)} ${Buffer.byteLength(payload)} ${shellQuote(createHash('sha256').update(payload).digest('hex'))} ${shellQuote(input.directory.slice(0, input.directory.lastIndexOf('/')))}`,
    input: payload }
}

/**
 * Read the original supervisor and persist complete output before returning an outcome.
 * @param driver - authenticated SSH operations.
 * @param target - selected account.
 * @param directory - original command directory, never a newly generated operation.
 * @param root - local observation directory.
 * @param source - source identity already bound to the command.
 * @param policy - read and reconnection bounds.
 * @param password - private transport credential.
 * @param signal - cancellation for reads; a cancelled command is stopped through its original supervisor.
 * @param stop - request cancellation without launching the command again.
 * @returns confirmed outcome and complete bounded tails; unknown outcomes remain explicitly fenced.
 */
export async function recoverPreparationCommand(driver: PreparationCommandDriver, target: Target, directory: string, root: string,
  source: ObservationSource, policy: PreparationCommandPolicy, password: string | undefined, signal: AbortSignal, stop = false): Promise<RecoveredPreparationCommand> {
  const started = Date.now()
  let offset = 0
  let stdout = ''; let stderr = ''
  let failedSince: number | undefined
  let requestedStop = false
  for (;;) {
    signal.throwIfAborted()
    const command = `if [ -f ${shellQuote(directory + '/command.py')} ]; then
python3 -B -I ${shellQuote(directory + '/command.py')} ${stop && !requestedStop ? 'stop' : 'read'} ${shellQuote(directory)} ${offset}
elif [ -f ${shellQuote(directory + '/request.v1.json')} ] && [ ! -f ${shellQuote(directory + '/shell-only')} ]; then printf unknown
elif [ -f ${shellQuote(directory + '/exited')} ]; then cat ${shellQuote(directory + '/exited')}; else printf unknown; fi`
    let raw: string
    try {
      raw = await driver.remote({ ...target, toolTimeoutMs: policy.readTimeoutMs }, command, signal, password)
      requestedStop = stop
      failedSince = undefined
    } catch (error) {
      signal.throwIfAborted()
      failedSince ??= Date.now()
      if (Date.now() - failedSince >= policy.recoveryTimeoutMs) throw new Error(`Original preparation command cannot be reached: ${String(error)}`)
      await delay(policy.pollIntervalMs, undefined, { signal }); continue
    }
    if (/^\d+\s*$/.test(raw)) {
      return { stdout, stderr, exitCode: Number(raw.trim()), signal: null, timedOut: false, cancelled: false, exitConfirmed: true, supervised: false }
    }
    if (raw === 'unknown') {
      if (Date.now() - started >= policy.recoveryTimeoutMs) throw new Error(`Original preparation command has no confirmed exit: ${directory}`)
      await delay(policy.pollIntervalMs, undefined, { signal }); continue
    }
    const page = pageSchema.parse(JSON.parse(raw))
    if (page.status.experimentId !== source.experimentId || page.status.serverId !== source.serverId || page.status.commandId !== source.commandId
      || page.status.sessionId !== source.sessionId || page.status.toolCallId !== source.toolCallId || page.offset < offset) throw new Error('Preparation output belongs to another invocation')
    for (const row of page.lines) {
      if (row.stream === 'stdout') stdout = (stdout + row.text).slice(-2_000_000)
      else stderr = (stderr + row.text).slice(-2_000_000)
    }
    importObservation(root, { ...source, complete: page.status.exitConfirmed && !page.hasMore }, page.lines, password ? [password] : [])
    offset = page.offset
    if (page.status.exitConfirmed && !page.hasMore) return { stdout, stderr: stderr || page.status.reason
      || (page.status.timedOut ? 'Preparation command exhausted its shared download/command budget; original process-group exit is confirmed and materials were retained.' : ''),
      exitCode: page.status.exitCode, signal: page.status.signal, timedOut: page.status.timedOut, cancelled: page.status.cancelled, exitConfirmed: true, supervised: true }
    if (page.status.finishedAt !== undefined && !page.status.exitConfirmed) throw new Error(`Original preparation process exit remains unconfirmed: ${page.status.reason ?? directory}`)
    if (page.status.supervisorMissing) throw new Error(`Original preparation process exit remains unconfirmed: ${page.status.reason}`)
    if (Date.now() - started > target.toolTimeoutMs + policy.recoveryTimeoutMs && !page.status.exitConfirmed) throw new Error(`Original preparation command did not confirm exit within its recovery budget: ${directory}`)
    if (!page.hasMore) await delay(policy.pollIntervalMs, undefined, { signal })
  }
}

/**
 * Find the already registered source for recovery after a local restart.
 * @param root - local experiment observations.
 * @param directory - saved pending command.
 * @returns the source identity, if this application created an observation for it.
 */
export function preparationCommandSource(root: string, directory: string): ObservationSource | undefined {
  return observationSources(root).find(source => source.commandId === directory.split('/').at(-1))
}
