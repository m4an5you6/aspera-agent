/** Credential-free GPU observations and authenticated controller maintenance results. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** One authenticated maintenance operation retained across preparation retries. */
export type ControllerRepairId = string & Branded<'AsperaControllerRepairId'>
/** One resident control process, independent of its reusable PID. */
export type ControllerBootId = string & Branded<'AsperaControllerBootId'>
/** Durable maintenance identity. */
export const controllerRepairIdSchema = z.uuid().transform(value => brandString<ControllerRepairId>(value))
/** Current or verified legacy controller startup identity. */
export const controllerBootIdSchema = z.string().min(1).transform(value => brandString<ControllerBootId>(value))

/** NVIDIA identities are compared independently of the container's device numbering. */
export const gpuInventorySchema = z.object({
  gpus: z.array(z.object({ uuid: z.string().regex(/^GPU-[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/), name: z.string().min(1),
    devicePath: z.string().regex(/^\/dev\/nvidia\d+$/) }).strict()).min(1),
  devicePaths: z.array(z.string().regex(/^\/dev\/nvidia(?:\d+|ctl|-uvm|-uvm-tools|-modeset|-caps\/nvidia-cap\d+)$/)).min(1),
}).strict()
/** Actual identities and accessible NVIDIA character devices. */
export type GpuInventory = z.infer<typeof gpuInventorySchema>

/** @param inventory - GPU observations. @returns canonical values independent of report order. */
export function normalizedGpuInventory(inventory: GpuInventory): GpuInventory {
  return { gpus: inventory.gpus.map(gpu => ({ uuid: gpu.uuid.toLowerCase(), name: gpu.name, devicePath: gpu.devicePath })).sort((a, b) => a.uuid.localeCompare(b.uuid)),
    devicePaths: normalizedSet(inventory.devicePaths) }
}

/** @param values - observed paths or identities. @returns a sorted set for comparisons. */
export function normalizedSet(values: readonly string[]): string[] { return [...new Set(values)].sort() }

/** @param query - UUID/name/minor-number rows from NVIDIA XML. @param devices - actual character devices. @returns validated accessible GPUs. */
export function parseGpuInventory(query: string, devices: readonly string[]): GpuInventory {
  const devicePaths = normalizedSet(devices)
  const gpus = query.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const columns = line.split(',').map(value => value.trim())
    const uuid = columns.shift(); const minor = columns.pop()
    if (uuid === undefined || minor === undefined || !/^\d+$/.test(minor)) throw new Error('GPU identity query is incomplete')
    return { uuid, name: columns.join(', '), devicePath: `/dev/nvidia${Number(minor)}` }
  }).filter(gpu => devicePaths.includes(gpu.devicePath)).sort((a, b) => a.uuid.localeCompare(b.uuid))
  const inventory = gpuInventorySchema.parse({ gpus, devicePaths })
  if (new Set(gpus.map(gpu => gpu.uuid.toLowerCase())).size !== gpus.length || new Set(gpus.map(gpu => gpu.devicePath)).size !== gpus.length
    || devicePaths.filter(path => /^\/dev\/nvidia\d+$/.test(path)).some(path => !gpus.some(gpu => gpu.devicePath === path))) {
    throw new Error('GPU identity query does not match the accessible character devices')
  }
  return inventory
}

/** @param info - frozen nvidia-smi inventory text. @returns nonempty, normalized UUIDs; refuses unknown identities. */
export function gpuIdentities(info: string): string[] {
  const ids = normalizedSet([...info.matchAll(/\bGPU-[a-fA-F0-9-]{36}\b/g)].map(match => match[0].toLowerCase()))
  if (ids.length === 0) throw new Error('Saved GPU identity is unavailable; copy this experiment after confirming its hardware')
  return ids
}

/** @param inventory - actual GPU facts. @returns the existing submission's textual GPU inventory. */
export function gpuInventoryText(inventory: GpuInventory): string {
  return inventory.gpus.map((gpu, index) => `GPU ${index}: ${gpu.name} (UUID: ${gpu.uuid})`).join('\n') + '\n'
}

/** A control process owns its fixed authorization until a verified restart. */
export const controllerStatusSchema = z.object({
  version: z.literal(1), role: z.enum(['node', 'coordinator']), bootId: controllerBootIdSchema,
  deploymentId: z.string().regex(/^[a-f0-9]{64}$/), root: z.string().startsWith('/'), pid: z.number().int().positive(),
  processStart: z.string().regex(/^\d+$/).optional(), hostBootId: z.string().optional(),
  policy: z.object({ backendPath: z.string().startsWith('/'), hiddenPaths: z.array(z.string()), devicePaths: z.array(z.string()),
    gpu: gpuInventorySchema.optional() }).strict(), policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  maintenance: controllerRepairIdSchema.optional(),
  occupied: z.object({ experiments: z.array(z.string()), allocations: z.array(z.string()), commands: z.array(z.string()), services: z.array(z.string()) }).strict(),
  actualGpu: gpuInventorySchema.optional(), gpuError: z.string().optional(),
  legacy: z.boolean().optional(),
}).strict()
/** Current process identity, authorization and independently observed occupancy. */
export type ControllerStatus = z.infer<typeof controllerStatusSchema>

/** Compare-and-set request cannot stop a replacement process or overwrite another maintenance owner. */
export const controllerMaintenanceSchema = z.object({ operationId: controllerRepairIdSchema, bootId: controllerBootIdSchema, policyDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
/** Program-owned maintenance identity. */
export type ControllerMaintenance = z.infer<typeof controllerMaintenanceSchema>
