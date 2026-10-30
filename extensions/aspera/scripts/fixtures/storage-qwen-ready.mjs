/** Observe the real profile listener without replacing providers or tools. */
import { writeFileSync, renameSync } from 'node:fs'
export const inject = ['webServer']
/** @param ctx - shipped profile. @param config - private readiness filename. */
export function apply(ctx, config) {
  writeFileSync(config.path + '.incoming', JSON.stringify({ port: ctx.webServer.port }), { mode: 0o600 })
  renameSync(config.path + '.incoming', config.path)
}
