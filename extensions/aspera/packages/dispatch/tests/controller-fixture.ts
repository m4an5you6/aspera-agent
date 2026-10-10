/** Explicit CPU-only GPU/controller observations shared by preparation tests. */
import { controllerPolicyDigest } from '@aspera/runtime'
import type { ControllerStatus, GpuInventory } from '@aspera/experiments'
import { controllerBootIdSchema } from '@aspera/experiments'
import type { DeploymentConfig, PreparedEnvironment } from '../src/deploy.ts'

export const fixtureGpu: GpuInventory = { gpus: [{ uuid: 'GPU-11111111-1111-1111-1111-111111111111', name: 'CPU fixture GPU', devicePath: '/dev/nvidia0' }], devicePaths: ['/dev/nvidia0'] }
/** @param digest - original release. @returns simulated program verification, never real GPU acceptance. */
export function preparedFixture(digest = 'a'.repeat(64)): PreparedEnvironment {
  return { state: 'ready', deploymentId: digest, preparationId: digest, backend: 'bwrap', backendPath: '/usr/bin/bwrap',
    sandboxWriteProbe: 'passed', cudaProbe: 'passed', workspaceRoot: '/runs/workspace', devicePaths: [...fixtureGpu.devicePaths], hiddenPaths: [], gpu: structuredClone(fixtureGpu) }
}
/** @param target - selected control root. @param role - selected process. @returns public simulated process facts. */
export function controllerFixture(target: Pick<DeploymentConfig, 'remoteRoot'>, role: 'coordinator' | 'node' = 'node'): ControllerStatus {
  const policy = { backendPath: '/usr/bin/bwrap', hiddenPaths: [], devicePaths: [...fixtureGpu.devicePaths], gpu: structuredClone(fixtureGpu) }
  return { version: 1, role, bootId: controllerBootIdSchema.parse('cpu-original'), deploymentId: 'a'.repeat(64), root: target.remoteRoot, pid: 1000,
    processStart: '123', hostBootId: 'cpu-host-boot', policy, policyDigest: controllerPolicyDigest(policy),
    occupied: { experiments: [], allocations: [], commands: [], services: [] }, actualGpu: structuredClone(fixtureGpu) }
}
