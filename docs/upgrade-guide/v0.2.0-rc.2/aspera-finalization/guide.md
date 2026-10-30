---
kind: upgrade-guide
description: "Aspera commands wait for cleanup, training stages use approved arithmetic, and historical blocked results support restricted supplementation."
---

# Aspera stage acceptance and finalization

English | [中文](guide.zh.md)

## Change

Command tools wait for terminal exit and cleanup. `run_experiment_command_group` launches all distributed members before waiting, without model polling. Observation cancellation and transport failure do not prove exit.

Command retries require matching content and purpose, saved in format `0.1.4` wait records and verified by authenticated status. Older waits remain readable; missing identity cannot confirm a new request. `asperaEnvironmentTools.commandIdentityVersion: 1` requires `command-wait-identity-v1`. Changed commands need new run IDs; old releases stay fixed.

Read returned stdout/stderr references through `read_experiment_file(command_id, stream, offset, generation?)`; diagnostics have no inferred workspace log. `finalization.commandOutputBytes` defaults to 8192; optional `ProcessLogRequest.limit` bounds transport pages. Manifest `asperaEnvironmentTools.commandOutputVersion: 1` requires `command-output-v1`. Persistent stream and Session formats stay unchanged.

Training plans declare stages before approval and register effective parameters/evidence before launch. Program checks distinguish additional/cumulative steps, metric coverage, samples and restored schedulers. All finish requests inspect real work; unverified blockers receive `finalization.reasonCorrections` opportunities before incomplete-Agent termination.

Released blocked experiments with independently confirmed original training and finalization evidence can request restricted supplementation. Original outcomes and step files remain unchanged; only a verified independent receipt displays Revalidation passed. Review cannot train, evaluate or run inference.


`asperaStageAttemptVersion: 1` requires `stage-attempt-recovery-v1`. After confirmed failed exit and release, `register_experiment_stage` accepts `previousAttemptId` with new attempt/command IDs and separate result paths. Immutable successor journals retain original registrations and checks. Running, successful and uncertain attempts cannot be replaced. Eligibility is checked before retry-path guidance. Approved parameter and resume requirements remain fixed; historical review cannot retry training.

`asperaStageEvidenceVersion: 4` requires `stage-checkpoint-evidence-v4`, retaining earlier readers/checks. Native association requires complete state bytes, size and SHA-256 to match; results retain actual adapter paths. Native directories determine saving/retention independently of log snapshots. Earlier manifests remain readable.

`asperaAgentRecoveryVersion: 1` requires `agent-recovery-v1`. `finalization.outputTokenCorrections` defaults to two consecutive output-limit recoveries in the same Goal/Session; a tool result resets the count. Corrections are logged and do not replay commands. Older releases do not receive this setting.

## Migration

`asperaCheckpointProtectionVersion: 1` requires `checkpoint-protection-v1`. Approved recovery groups become read-only after successful producer exit; pending writers exclude concurrent mutation and changed identities block mutation. Preserve successful checkpoints and correct evidence without retraining. Apply protection to a new copy after confirmed release; old runs stay fixed.

1. Rebuild Remote consumers for `experimentCompletionAssessment` and `experimentFinalizationStatus`. Configure `finalization` polling, read/reconnect budgets and correction limits through the profile when defaults do not fit deployment requirements.
2. Use `asperaFinalizationVersion: 2` releases with the declared attempt/evidence capabilities; preparation checks controller compatibility. Keep original experiments and releases fixed.
3. Plan Transformers/ms-swift/PEFT stages with explicit cumulative/additional steps and scheduler semantics. Replace model log polling with waiting command tools; use dedicated tools for resident services.
4. `recoverExperimentAcceptance(id, recoveryId?)` binds inference recovery to native checkpoints and public checks. Source previews add text digests and masking status; observation timeouts use `finalization.reconnectTimeoutMs`. Original review remains mandatory; never retrain. [Independent recovery records](../../../../extensions/aspera/docs/completion-review.md#recover-acceptance-on-the-original-experiment) preserve original outcomes, protocol 4, fleet 6 and Session formats.
