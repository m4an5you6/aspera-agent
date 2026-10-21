/** Linux command launches retain process-group identities without changing sandbox parameters. */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExperimentId, ExperimentServerId } from '@aspera/experiments'

/**
 * Publish a version-1 ownership file before exec; unsupported hosts keep the original argv.
 * @param runRoot - program-resolved private experiment directory.
 * @param binding - original experiment, node and validated command id.
 * @param argv - complete sandbox command, including every isolation flag.
 * @returns process-wrapper argv on Linux; offline stopping on other hosts remains unsupported.
 */
export function ownedCommandArgv(runRoot: string, binding: { experimentId: ExperimentId; serverId: ExperimentServerId; commandId: string; controlRoot: string; deploymentId: string; environmentOperation?: string; cacheCleanup?: boolean },
  argv: string[]): string[] {
  if (process.platform !== 'linux') return argv
  return ['python3', fileURLToPath(new URL('../scripts/owned-command.py', import.meta.url)),
    resolve(runRoot, 'process-identities', `${binding.commandId}.v1.json`), JSON.stringify(binding), ...argv]
}

/**
 * Fence Agent startup through the same Linux admission lock without changing its DSH profile.
 * @param runRoot - original private run directory. @param binding - fixed experiment, node, release and role.
 * @param argv - supported profile launch. @returns identity-publishing argv, or unchanged argv on other hosts.
 */
export function ownedAgentArgv(runRoot: string, binding: { experimentId: ExperimentId; serverId: ExperimentServerId; controlRoot: string;
  deploymentId: string; role: 'planner' | 'agent' }, argv: string[]): string[] {
  if (process.platform !== 'linux') return argv
  return ['python3', fileURLToPath(new URL('../scripts/owned-command.py', import.meta.url)),
    resolve(runRoot, 'agent-identities', `${binding.role}-${randomUUID()}.v1.json`), JSON.stringify(binding), ...argv]
}
