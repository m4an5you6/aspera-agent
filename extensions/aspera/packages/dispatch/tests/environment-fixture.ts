/** CPU observations model installed tools without claiming a real kernel or GPU check. */
import type { ServerEnvironment } from '@aspera/experiments'

/** Construct independent observations for a configured Linux account.
 * @returns a complete fixture environment.
 */
export function readyEnvironment(): ServerEnvironment {
  return { home: '/home/trainer', system: 'Linux', architecture: 'x86_64', identity: 'uid=1000(trainer)',
    programs: [
      { name: 'node', path: '/usr/bin/node', version: 'v24.1.0' },
      { name: 'pnpm', path: '/usr/bin/pnpm', version: '11.7.0' },
      { name: 'python3', path: '/usr/bin/python3', version: 'Python 3.12.0' },
      { name: 'bwrap', path: '/usr/bin/bwrap', version: 'bubblewrap 0.11.0' },
    ], sandboxExitCode: 0, diagnostics: 'CPU fixture: tools available' }
}
