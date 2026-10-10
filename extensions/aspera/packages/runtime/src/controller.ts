/** Actual GPU probes and identity-bound controller authorization. */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { normalizedSet, normalizedGpuInventory, parseGpuInventory } from '@aspera/experiments'
import type { ControllerStatus, GpuInventory } from '@aspera/experiments'
import { gpuIdentityQueryScript } from './gpu-query.ts'

/** @param ctx - owned subprocess provider. @param root - controller working directory. @param timeoutMs - operation limit. @returns current GPU identities and character devices. */
export async function probeControllerGpu(ctx: Context, root: string, timeoutMs: number): Promise<GpuInventory> {
  const devices = readdirSync('/dev').filter(name => /^nvidia(?:\d+|ctl|-uvm|-uvm-tools|-modeset)$/.test(name)).map(name => `/dev/${name}`)
  try { devices.push(...readdirSync('/dev/nvidia-caps').filter(name => /^nvidia-cap\d+$/.test(name)).map(name => `/dev/nvidia-caps/${name}`)) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  const accessible = devices.filter(path => statSync(path).isCharacterDevice())
  const child = ctx.subprocess.spawn({ argv: ['python3', '-c', gpuIdentityQueryScript, String(timeoutMs / 1000)], cwd: root,
    signal: AbortSignal.timeout(timeoutMs), graceMs: timeoutMs, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
  let stdout = ''; let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(-65536) })
  child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-65536) })
  const exit = await child.done.finally(async () => {
    child.terminate()
    if (!await child.waitForExit(AbortSignal.timeout(timeoutMs))) throw new Error('GPU probe exit is unconfirmed')
  })
  if (exit.exitCode !== 0) throw new Error(`GPU probe exited ${exit.exitCode}: ${stderr}`)
  return parseGpuInventory(stdout, accessible)
}

/** @param policy - fixed controller authorization. @returns normalized digest independent of list order. */
export function controllerPolicyDigest(policy: ControllerStatus['policy']): string {
  return createHash('sha256').update(JSON.stringify({ backendPath: policy.backendPath,
    hiddenPaths: normalizedSet(policy.hiddenPaths), devicePaths: normalizedSet(policy.devicePaths),
    gpu: policy.gpu === undefined ? null : normalizedGpuInventory(policy.gpu) })).digest('hex')
}

/** @returns Linux process and host boot identity; other hosts cannot authorize a remote restart. */
export function controllerProcessIdentity(): Pick<ControllerStatus, 'pid' | 'processStart' | 'hostBootId'> {
  if (process.platform !== 'linux') return { pid: process.pid }
  const stat = readFileSync('/proc/self/stat', 'utf8')
  return { pid: process.pid, processStart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
    hostBootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() }
}
