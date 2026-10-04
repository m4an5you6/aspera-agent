/** Public, credential-free observations of a node's preparation environment. */
import { z } from 'zod'

/** Executable search directories are absolute POSIX paths without PATH separators. */
export const executableDirectoriesSchema = z.array(z.string().startsWith('/').refine(value =>
  ![':', '\r', '\n', '\0'].some(separator => value.includes(separator)))).max(64)

/** Shell observations remain available before Node or Aspera is installed. */
export const serverEnvironmentSchema = z.object({
  home: z.string().startsWith('/'), system: z.string(), architecture: z.string(), identity: z.string(),
  programs: z.array(z.object({ name: z.enum(['node', 'pnpm', 'python3', 'bwrap']), path: z.string(), version: z.string() })),
  sandboxExitCode: z.number().int(), diagnostics: z.string(),
})
/** Observed tools and sandbox result, without credentials. */
export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>

/** Paths and versions verified before the dispatcher starts a remote profile. */
export const preparedToolchainSchema = z.object({
  pathEntries: executableDirectoriesSchema,
  node: z.string().startsWith('/'), pnpm: z.string().startsWith('/'),
  python3: z.string().startsWith('/'), bwrap: z.string().startsWith('/'),
  nodeVersion: z.string(), pnpmVersion: z.string(),
})
/** Saved executable paths used consistently by probes and remote profile launches. */
export type PreparedToolchain = z.infer<typeof preparedToolchainSchema>
