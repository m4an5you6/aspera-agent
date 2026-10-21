# Completion evidence and retrospective verification

English | [中文](completion-review.zh.md)

## Summary

Aspera checks completion before ending an execution Goal and again before settling the worker result. Released experiments that failed specifically because completion evidence was missing can request a separate, read-only evidence review. Training, environments, original results, logs, Sessions and fixed releases remain retained.

## Table of Contents

- [Normal completion](#normal-completion)
- [Review an existing result](#review-an-existing-result)
- [Verification and ownership](#verification-and-ownership)
- [Persistence and API](#persistence-and-api)
- [Validation](#validation)

## Normal completion

`inspect_experiment_completion`, `finish_experiment(completed)` and final settlement use the same [completion checks](../packages/runtime/src/completion-check.ts). They require matching completed reports for the approved plan and execution Session, execution entries on every selected node, effective parameters, verified environments, settled successful commands or registered healthy services, readable scripts and declared artifacts. Optional source references are independently hashed and rechecked. Entry write failures retain an uncommitted marker and block completion.

Missing evidence returns the affected node, failed check and recording instruction while the original Goal remains active. The execution Agent records actual framework, version, script, environment, parameters, artifacts and evaluation with `record_experiment_execution`, then requests completion again. A Markdown report, `plan_json`, finish detail or completed step report does not save an execution entry. Settled commands must not be repeated to repair missing records.

## Review an existing result

Open an eligible experiment and select **Supplement and verify**. Evidence-omission failures require the approved plan, original completed-Goal/finish-call evidence, confirmed command exits and release of all original resources. Released blocked continuations additionally require independently confirmed training endpoints and original blocked finish evidence under the [stage review rules](finalization.md#historical-review). Other training failures, cancellation and interruption are ineligible. An error string alone is insufficient. All original nodes must remain verifiable.

The Host starts a standard DSH Agent with the original execution model in a separate review Session. Its tools read original requirements, plan reports, command results, files and trajectory, inspect completion, record supplementary execution evidence and request verification. It has no command, installation, training, inference, service or deletion tools. Cancelling stops only this Agent and its reads; hiding the window or changing pages does not stop it. Restarting Aspera resumes the saved operation and Session. Repeated requests share the operation; blocked retries preserve its identity.

The overview and list display **Revalidation passed** only after the program commits a valid review receipt. The original failed or blocked result and timestamp remain available. Blocked reviews show missing evidence and retry; their animations stop. Review Agent records have their own read-only trajectory selector and are available locally. Review attachments that are not cached are unavailable offline.

## Verification and ownership

Review identity binds the experiment, original submission digest, plan revision, execution Session, result revision and selected nodes. Each source must be an original workspace file with independently observed generation, size and SHA-256. Parameters and evaluation values must match saved structured evidence; scripts and artifacts require their actual paths. Nonempty result evidence is required. Reports or model claims cannot replace source reads. Verification repeats source, environment, original outcome, node allocation and command-release checks before committing a separate receipt. Changed files and conflicting identities block publication.

An existing `pyenv` can be registered as a historical environment by reading its interpreter identity, `pyvenv.cfg` and dependency metadata. Framework versions must match. This operation does not execute experiment code, import packages, install, modify or copy dependencies. The record is usable only for the original experiment review; it does not enter the shared package store or replace new experiments' managed environment requirements.

Protocol-4 authenticated history reads remain available. An offline or older controller uses the program-owned [SSH evidence reader](../packages/dispatch/src/completion-reader.ts), which verifies run ownership, original allocation release and fixed release identity. Reads reject traversal, symlinks and nested mounts. The reader neither replaces releases nor edits original task ledgers. An unreachable node or missing original file remains unverified even when local history is readable. Review never reruns training, evaluation or inference to manufacture evidence.

Credential removal preserves parsed JSON and complete JSONL records, including embedded tool-result documents; null credential fields remain null. Parameters retain their exact saved keys and values. A recording rejection lists all parameter, evaluation and artifact mismatches together with available source values and keys. Invalid or incomplete structured evidence remains unverified. Each source path is read once within a recording or final recheck even when it supports several evidence purposes; final verification still reads fresh source identities.

## Persistence and API

Persistence acknowledgement: [completion schemas](../packages/experiments/src/completion.ts) add independent version-1 review, source and historical-environment records. `$DSH_HOME/aspera-completion-reviews/<experimentId>.v1.json` retains operation status, source identities, entries, original failure and verification time; a companion operation JSONL contains redacted Session events. The standard supplementary Session is also persisted by DSH. Local review workspaces reside under `$DSH_HOME/aspera-run-records/<experimentId>/review/<operationId>`. The remote run receives only `completion-reviews-v1/<operationId>.json`. Normal execution adds `execution-sources.v1.jsonl` and an uncommitted `execution-record-pending.v1.json` marker beside the unchanged `executions.jsonl` format. Fleet domain 6, submission protocol 4, original step files and released Session formats are unchanged.

`reviewExperimentCompletion(id)` acknowledges background review; `experimentCompletionReviewStatus(id)` reads its saved status; `cancelExperimentCompletionReview(id)` stops supplementary work. `experimentCompletionReviewTrace(id, operationId, request)` provides bounded, operation-bound local pages. Generated Remote consumers include these methods. Original fleet persistence and remote failed outcomes stay unchanged; the Host projects the independent assessment for status, filtering and counts. Deletion first stops and awaits the review, then removes its local records. Tombstones reject late writes. Disk errors block the review without changing training results.

Review trajectory pages read the original local DSH Session and redact parsed events before publication. An older damaged supplementary JSONL copy cannot hide an intact Session; reading it does not restart the Agent, rerun verification or rewrite either history. The validated supplementary copy remains a fallback when the original Session is absent. A failed Session read is reported rather than replaced with an apparently complete trajectory.

New releases advertise `completion-evidence-v1`, selected through manifest `asperaCompletionVersion: 1`. Preparation verifies this capability before reusing a controller. Existing experiments keep their original release; retrospective reading does not upgrade it.

## Validation

`test:worker` replays the shipped execution profile with an omitted execution entry, recoverable completion checks and a single settled command. `test:completion` runs the standard restricted review Agent and real Remote/Web views with CPU evidence, including missing-source blocking, cancellation, retained failure, read-only historical metadata and supplementary trajectory. Unit tests cover ownership, hashing, identity conflicts and lifecycle recovery. These local checks do not establish real Linux mount isolation, historical remote file authenticity or GPU/CUDA acceptance; those require the original available nodes.
