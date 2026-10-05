/** Actual node resource samples; failed samples remain explicit gaps. */
import { cpus, freemem, totalmem } from 'node:os'
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { metricReadSchema, metricSampleSchema } from '@aspera/experiments'
import type { MetricRead, MetricSample, ObservationPolicy } from '@aspera/experiments'
import { observationRoot } from './observations.ts'

function cpuTimes(): { idle: number; total: number } {
  return cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 })
}

/** One serialized sampler owned by the node controller. */
export class NodeMetricSampler {
  private previous = cpuTimes()
  constructor(private readonly ctx: Context, private readonly policy: ObservationPolicy) {}
  /** @param signal - sampler lifetime. @returns measured machine values with missing GPU data preserved. */
  async sample(signal: AbortSignal): Promise<Omit<MetricSample, 'experimentId' | 'serverId'>> {
    const now = cpuTimes(); const delta = now.total - this.previous.total
    const cpuPercent = delta > 0 ? 100 * (1 - (now.idle - this.previous.idle) / delta) : undefined
    this.previous = now
    const value: Omit<MetricSample, 'experimentId' | 'serverId'> = { time: Date.now(),
      ...(cpuPercent === undefined ? {} : { cpuPercent }), memoryUsedBytes: totalmem() - freemem(), memoryTotalBytes: totalmem(), gpus: [] }
    try {
      const child = this.ctx.subprocess.spawn({ argv: ['nvidia-smi', '--query-gpu=uuid,name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
        cwd: process.cwd(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.policy.intervalMs)]), graceMs: this.policy.intervalMs,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
      let text = ''; child.stdout?.on('data', (chunk: Buffer) => { text = (text + chunk.toString('utf8')).slice(-65536) })
      child.stderr?.resume()
      const result = await child.done.finally(async () => {
        child.terminate()
        if (!await child.waitForExit(AbortSignal.timeout(this.policy.intervalMs))) throw new Error('GPU sample process exit is unconfirmed')
      })
      if (result.exitCode !== 0) throw new Error('GPU metrics unavailable')
      value.gpus = text.trim().split('\n').filter(Boolean).map(line => {
        const [id, name, utilization, used, total] = line.split(',').map(value => value.trim())
        const finite = (text: string | undefined) => text === undefined || text === '' || !Number.isFinite(Number(text)) ? undefined : Number(text)
        return { id: id ?? '', name: name ?? '', ...(finite(utilization) === undefined ? {} : { utilization: finite(utilization) }),
          ...(finite(used) === undefined ? {} : { memoryUsedBytes: Number(used) * 1048576 }), ...(finite(total) === undefined ? {} : { memoryTotalBytes: Number(total) * 1048576 }) }
      })
    } catch (error) { if (signal.aborted) throw error; value.error = 'GPU metrics unavailable' }
    return value
  }
}

/** @param root - experiment run directory. @param sample - actual sample. @param policy - bounded retention. @param kind - resource or reported training series. */
export function saveMetricSample(root: string, sample: MetricSample, policy: ObservationPolicy, kind: 'metrics' | 'training' = 'metrics'): void {
  sample = metricSampleSchema.parse(sample)
  const directory = observationRoot(root); mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = resolve(directory, `${kind}.jsonl`)
  if ([path, `${path}.incoming`].some(file => existsSync(file) && lstatSync(file).isSymbolicLink())) throw new Error('Metric files cannot be symbolic links')
  const previous = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => metricSampleSchema.parse(JSON.parse(line))) : []
  const samples = [...previous.filter(value => value.time > sample.time - policy.historyMs), sample].slice(-policy.metricSamples)
  writeFileSync(`${path}.incoming`, samples.map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 }); renameSync(`${path}.incoming`, path)
}

/** @param root - owned run directory. @param raw - bound metric query. @param kind - resource or reported training series. @returns available samples, preserving gaps. */
export function readMetricSamples(root: string, raw: MetricRead, kind: 'metrics' | 'training' = 'metrics'): MetricSample[] {
  const request = metricReadSchema.parse(raw); const path = resolve(observationRoot(root), `${kind}.jsonl`)
  if (!existsSync(path)) return []
  if (lstatSync(path).isSymbolicLink()) throw new Error('Metric files cannot be symbolic links')
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => metricSampleSchema.parse(JSON.parse(line))).filter(sample => {
    if (sample.experimentId !== request.experimentId || sample.serverId !== request.serverId) throw new Error('Metrics belong to another experiment or node')
    return (request.after === undefined || sample.time > request.after) && (request.before === undefined || sample.time < request.before)
  }).slice(-request.limit)
}
