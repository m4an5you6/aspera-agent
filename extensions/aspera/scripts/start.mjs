/** Starts the independent management application through its dsh profile. */
import './setup.mjs'
process.argv.splice(2, 0, '--profile', 'aspera')
await import('./dsh.mjs')
