/** Program-owned immutable evidence source. */
export interface CompletionFileRequest { runRoot: string; experimentId: string; serverId: string; path: string; maxBytes: number; privateSource?: boolean; metadataOnly?: boolean }
/** @param request - confined source. @returns stable content and identity. */
export function inspectCompletionFile(request: CompletionFileRequest): { sha256: string; generation: string; bytes: number; text: string; tail: string; truncated: boolean }
/** @param request - pinned Session and metadata budget. @returns independently observed finish and Goal evidence. */
export function inspectCompletionSession(request: Omit<CompletionFileRequest, 'path'> & { sessionId: string }): { sessionId: string; finished: boolean; finishStatus?: 'completed' | 'blocked'; sha256: string; generation: string }
/** @param request - bounded, owned workspace discovery. @returns existing evidence candidates. */
export function listCompletionFiles(request: Omit<CompletionFileRequest, 'path'> & { maxEntries: number; excludeDirectories: string[] }): { files: { serverId: string; path: string; bytes: number }[]; truncated: boolean }
/** @param request - program-bound original assignment. @returns verified immutable node and fixed release identity. */
export function inspectCompletionIdentity(request: Omit<CompletionFileRequest, 'path'> & { controlRoot: string; releaseRoot: string; deploymentId: string; node: import('@aspera/experiments').ClusterNode }): { verified: true }
/** @param request - original, unchanged Python directory. @returns metadata-only historical evidence. */
export function inspectHistoricalEnvironment(request: Omit<CompletionFileRequest, 'path'> & { environment: string; framework: string; version: string }): import('@aspera/experiments').HistoricalEnvironment
/** @param request - original operation and program-selected output directory. @returns committed digest. */
export function saveCompletionReview(request: Omit<CompletionFileRequest, 'path'> & { receipt: import('@aspera/experiments').CompletionReview }): { sha256: string }
/** @param request - original owned directory and separate supplementary assessment. @returns durable digest. */
export function saveCompletionAssessment(request: Omit<CompletionFileRequest, 'path'> & { assessment: import('@aspera/experiments').CompletionAssessment }): { sha256: string }
/** @param request - original coordinator and journal bounds. @returns lightweight finalization observations. */
export function inspectExperimentFinalization(request: Omit<CompletionFileRequest, 'path'> & { maxEntries: number }): import('@aspera/experiments').ExperimentFinalizationStatus
