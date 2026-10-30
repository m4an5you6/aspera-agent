/** Shell-only environment inspection and deterministic executable verification. */
import { readFileSync } from 'node:fs'
import { resolve, posix } from 'node:path'
import { satisfies, valid, validRange } from 'semver'
import { z } from 'zod'
import { serverEnvironmentSchema, preparedToolchainSchema, planningReleaseSchema } from '@aspera/experiments'
import type { ServerEnvironment, PreparedToolchain } from '@aspera/experiments'
import { remote, remoteResult, RemoteCommandError, shellQuote } from './transport.ts'
import type { Target } from './transport.ts'
import { SavedReleaseUnavailable, verifySavedRelease } from './cluster-deploy.ts'
import { experimentIsolationArgs } from '@aspera/runtime'

/** Runtime requirements owned by the source release manifest. */
export interface EnvironmentRequirements { node: string; pnpm: string; uv?: string; pip?: string; registrationFormat?: '0.1.3' }

const environmentTools = z.object({ uvVersion: z.string().regex(/^\d+\.\d+\.\d+$/), pipVersion: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/).optional(),
  sandboxIpcVersion: z.literal(1).optional(), readonlyConsumerVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  reusePrecheckVersion: z.literal(1).optional(), wheelMetadataRepairVersion: z.union([z.literal(1), z.literal(2)]).optional(), managerCacheVersion: z.literal(1).optional(), inputSharingVersion: z.literal(1).optional(), releaseAssetSharingVersion: z.literal(1).optional(),
  reuseVersion: z.literal(1).optional(), cleanupVersion: z.literal(1).optional(), installVersion: z.union([z.literal(2), z.literal(3)]).optional(), storageVersion: z.literal(1).optional(), storageFormat: z.literal('0.1.0').optional(), materialFormat: z.enum(['0.1.1', '0.1.2']).optional(), registrationFormat: z.literal('0.1.3').optional(), reuseVerificationVersion: z.literal(1).optional(), repairVersion: z.literal(1).optional(), storagePreflightVersion: z.literal(2).optional(), canonicalDatasetVersion: z.literal(1).optional(), sandboxVersion: z.literal(1).optional(), commandOutputVersion: z.literal(1).optional(), commandIdentityVersion: z.literal(1).optional(), materialRecoveryVersion: z.literal(1).optional(), lockReceiptVersion: z.literal(1).optional(), requirementLedgerVersion: z.literal(1).optional() })
  .strict().refine(value => value.installVersion !== 3 || value.pipVersion !== undefined, 'Installer v3 requires an exact pip version').optional()

const enginesSchema = z.object({ node: z.string().min(1).refine(value => validRange(value) !== null, 'Invalid Node engine range') })
const stageEvidenceVersion = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional()
// Historical release requirements stay fixed when the local application changes its Node support.
const legacyNodeEngines: Readonly<Record<string, string | undefined>> = {
  '0.1.1/0.2.0-rc.2/pnpm@11.7.0': '^22.19.0 || >=24.0.0',
}

/**
 * Read dependency versions from the independent application's release manifest.
 * @param root - source or installed application directory.
 * @param identity - verified historical release identity, when its manifest predates engines.
 * @returns Node engine range and fixed pnpm, uv and installer pip versions when declared.
 */
export function environmentRequirements(root: string, identity?: { extension: string; dsh: string }): EnvironmentRequirements {
  const manifest = z.object({ engines: enginesSchema.optional(), asperaCheckpointProtectionVersion: z.literal(1).optional(), asperaAgentRecoveryVersion: z.literal(1).optional(),
    packageManager: z.string().regex(/^pnpm@\d+\.\d+\.\d+$/), asperaEnvironmentTools: environmentTools, asperaPlanningTools: planningReleaseSchema.optional(), asperaStageAttemptVersion: z.literal(1).optional(), asperaStageEvidenceVersion: stageEvidenceVersion, asperaServiceVerificationVersion: z.literal(1).optional(), asperaServiceLifecycleVersion: z.literal(1).optional(), asperaInferenceCheckpointVersion: z.literal(1).optional() }).parse(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')))
  const node = manifest.engines?.node ?? (identity === undefined ? undefined : legacyNodeEngines[`${identity.extension}/${identity.dsh}/${manifest.packageManager}`])
  if (node === undefined) throw new Error('Original release has no recorded Node requirement')
  return { node, pnpm: manifest.packageManager.slice(5), ...(manifest.asperaEnvironmentTools?.registrationFormat === undefined ? {} : { registrationFormat: manifest.asperaEnvironmentTools.registrationFormat }), ...(manifest.asperaEnvironmentTools === undefined ? {} : { uv: manifest.asperaEnvironmentTools.uvVersion,
    ...(manifest.asperaEnvironmentTools.pipVersion === undefined ? {} : { pip: manifest.asperaEnvironmentTools.pipVersion }) }) }
}

/**
 * Read the original installed release's requirements using only SSH and cat.
 * @param target - saved node connection.
 * @param release - immutable saved release directory.
 * @param digest - saved release identity.
 * @param password - private credential.
 * @param signal - preparation cancellation.
 * @returns the original Node range and package manager version, including recorded compatibility for engine-less releases.
 */
export async function installedEnvironmentRequirements(target: Target, release: string, digest: string, password?: string, signal?: AbortSignal): Promise<EnvironmentRequirements> {
  const identity = await verifySavedRelease(target, release, digest, password, signal)
  try {
    const manifest = z.object({ packageManager: z.string().regex(/^pnpm@\d+\.\d+\.\d+$/), engines: enginesSchema.optional(), asperaCheckpointProtectionVersion: z.literal(1).optional(), asperaAgentRecoveryVersion: z.literal(1).optional(),
      dependencies: z.object({ '@deepseek-ai/dsh': z.literal(identity.dsh) }), asperaEnvironmentTools: environmentTools, asperaPlanningTools: planningReleaseSchema.optional(), asperaStageAttemptVersion: z.literal(1).optional(), asperaStageEvidenceVersion: stageEvidenceVersion, asperaServiceVerificationVersion: z.literal(1).optional(), asperaServiceLifecycleVersion: z.literal(1).optional(), asperaInferenceCheckpointVersion: z.literal(1).optional() })
      .parse(JSON.parse(await remote(target, `cat ${shellQuote(release + '/package.json')}`, signal, password)))
    let node = manifest.engines?.node
    if (node === undefined) {
      const dsh = z.object({ name: z.literal('@deepseek-ai/dsh'), version: z.literal(identity.dsh), engines: enginesSchema.optional() }).parse(
        JSON.parse(await remote(target, `cat ${shellQuote(release + '/node_modules/@deepseek-ai/dsh/package.json')}`, signal, password)))
      node = dsh.engines?.node ?? legacyNodeEngines[`${identity.extension}/${identity.dsh}/${manifest.packageManager}`]
    }
    if (node === undefined) throw new Error(`No recorded Node requirement for Aspera ${identity.extension}, DSH ${identity.dsh}, ${manifest.packageManager}`)
    return { node, pnpm: manifest.packageManager.slice(5), ...(manifest.asperaEnvironmentTools?.registrationFormat === undefined ? {} : { registrationFormat: manifest.asperaEnvironmentTools.registrationFormat }), ...(manifest.asperaEnvironmentTools === undefined ? {} : { uv: manifest.asperaEnvironmentTools.uvVersion,
      ...(manifest.asperaEnvironmentTools.pipVersion === undefined ? {} : { pip: manifest.asperaEnvironmentTools.pipVersion }) }) }
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof RemoteCommandError && !error.result.exitConfirmed) throw error
    throw new SavedReleaseUnavailable(`Cannot read the saved release requirements at ${release}; copy this experiment. ${String(error)}`)
  }
}

/**
 * Inspect a Linux SSH account without requiring Node, Python or a remote controller.
 * @param target - selected account and executable search directories.
 * @param password - private SSH credential.
 * @param signal - operation cancellation.
 * @returns actual command paths, versions and sandbox diagnostics.
 */
export async function inspectEnvironment(target: Target, password?: string, signal?: AbortSignal): Promise<ServerEnvironment> {
  const result = await remoteResult(target, `printf 'ASPERA_HOME=%s\\n' "$HOME"
printf 'ASPERA_SYSTEM=%s\\n' "$(uname -s)"
printf 'ASPERA_ARCH=%s\\n' "$(uname -m)"
printf 'ASPERA_ID=%s\\n' "$(id)"
test ! -f /etc/os-release || cat /etc/os-release
for program in node pnpm python3 bwrap uv; do
  binary=$(command -v "$program" || true)
  printf 'ASPERA_PATH_%s=%s\\n' "$program" "$binary"
  if [ -n "$binary" ]; then
    version=$("$binary" --version 2>&1)
    printf 'ASPERA_VERSION_%s=%s\\n' "$program" "$version"
  fi
done
if command -v bwrap >/dev/null 2>&1; then
  bwrap ${experimentIsolationArgs().map(shellQuote).join(' ')} -- true
  sandbox_status=$?
  if [ "$sandbox_status" -eq 0 ]; then
    bwrap ${experimentIsolationArgs().map(shellQuote).join(' ')} --size 1048576 --tmpfs /tmp -- true
    sandbox_status=$?
  fi
else sandbox_status=127; fi
printf 'ASPERA_SANDBOX=%s\\n' "$sandbox_status"
`, signal, password)
  if (!result.exitConfirmed || result.exitCode !== 0 || result.cancelled || result.timedOut) throw new RemoteCommandError(result)
  const fields = new Map(result.stdout.split(/\r?\n/).flatMap(line => {
    const match = /^(ASPERA_[A-Za-z0-9_]+)=(.*)$/.exec(line)
    return match === null ? [] : [[match[1]!, match[2]!] as const]
  }))
  return serverEnvironmentSchema.parse({
    home: fields.get('ASPERA_HOME'), system: fields.get('ASPERA_SYSTEM'),
    architecture: fields.get('ASPERA_ARCH'), identity: fields.get('ASPERA_ID'),
    programs: (['node', 'pnpm', 'python3', 'bwrap', 'uv'] as const).map(name => ({
      name, path: fields.get(`ASPERA_PATH_${name}`) ?? '', version: fields.get(`ASPERA_VERSION_${name}`) ?? '',
    })), sandboxExitCode: Number(fields.get('ASPERA_SANDBOX')),
    diagnostics: [result.stderr, result.stdout].filter(Boolean).join('\n'),
  })
}

/**
 * Check observed executables against the admitted release's requirements.
 * @param observation - fresh SSH evidence.
 * @param requirements - source release requirements.
 * @param pathEntries - requested executable directories, validated at the tool or storage parser.
 * @returns verified paths or all actionable failures.
 */
export function checkEnvironment(observation: ServerEnvironment, requirements: EnvironmentRequirements,
  pathEntries: readonly string[] = []): { ready: true; toolchain: PreparedToolchain } | { ready: false; failures: string[] } {
  const failures: string[] = []
  if (observation.system !== 'Linux') failures.push('The execution node must run Linux')
  const program = (name: string) => observation.programs.find(value => value.name === name)
  const node = program('node'); const pnpm = program('pnpm'); const python = program('python3'); const bwrap = program('bwrap')
  for (const name of ['node', 'pnpm', 'python3', 'bwrap']) {
    if (!program(name)?.path.startsWith('/')) failures.push(`${name} is missing from the non-interactive SSH PATH`)
  }
  if (!node || !valid(node.version) || !satisfies(node.version, requirements.node)) failures.push(`Node must satisfy ${requirements.node}; observed ${node?.version || 'missing'}`)
  if (pnpm?.version !== requirements.pnpm) failures.push(`pnpm must be ${requirements.pnpm}; observed ${pnpm?.version || 'missing'}`)
  if (!python?.version.startsWith('Python 3.')) failures.push('Python 3 is required for the CUDA probe')
  const uv = program('uv')
  if (requirements.uv !== undefined && (!uv?.path.startsWith('/') || uv.version.split(/\s+/)[1] !== requirements.uv)) failures.push(`uv must be ${requirements.uv}; observed ${uv?.version || 'missing'}`)
  if (observation.sandboxExitCode !== 0) failures.push(`bubblewrap probe exited ${observation.sandboxExitCode}: ${observation.diagnostics}`)
  if (failures.length > 0) return { ready: false, failures }
  const toolchain = preparedToolchainSchema.parse({
    node: node?.path, pnpm: pnpm?.path, python3: python?.path, bwrap: bwrap?.path,
    nodeVersion: node?.version, pnpmVersion: pnpm?.version,
    ...(requirements.uv === undefined ? {} : { uv: uv?.path, uvVersion: requirements.uv }),
    pathEntries: [...new Set([...pathEntries, ...observation.programs.filter(value => value.path.startsWith('/')).map(value => posix.dirname(value.path))])],
  })
  return { ready: true, toolchain }
}
