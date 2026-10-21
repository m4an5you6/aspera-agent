/** Fixed read-only helper used when original control releases cannot serve supplementary evidence. */
import { readFileSync } from 'node:fs'

/** @returns program-owned reads and receipt persistence, without a command execution interface. */
export function completionEvidenceProgram(): string { return readFileSync(new URL('../scripts/completion-files.mjs', import.meta.url), 'utf8') }
