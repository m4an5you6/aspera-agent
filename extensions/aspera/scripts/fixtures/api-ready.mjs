/** Observe the settled production profile without supplying application services. */
import { writeFileSync } from 'node:fs'

export const inject = ['loader']

/** Record readiness and required-service availability for the API startup check. */
export function apply(ctx, config) {
  void ctx.loader.await().then(() => {
    const services = ['storage', 'storageDomain', 'agents', 'goals', 'credentials', 'agentDefaultModel', 'sessionPersistence', 'tools']
    writeFileSync(config.ready, JSON.stringify(Object.fromEntries(services.map(key => [key, ctx.get(key) !== undefined]))))
  })
}
