---
kind: upgrade-guide
description: "Aspera background copies use separate running, backlog and waiting intervals and retain the previous result during checks."
---

# Aspera record-saving intervals

English | [中文](guide.zh.md)

## Change

The management profile's `archiveIntervalMs` default changes from 2000 to 15000 milliseconds. `archiveBacklogIntervalMs` defaults to 5000 and `archiveWaitingIntervalMs` to 30000. `archiveRetryMinMs` changes from 5000 to 10000; the 60000 maximum remains. Intervals start after a round finishes. Final copies stop automatic reads after terminal resource release and complete current tails, while preserving historical gaps.

`lastSyncedAt` records the last successful round, including checks without new bytes. Background checks keep the previous result instead of publishing `syncing` at their start. Existing status fields and saved index version remain readable; `incomplete` still identifies historical gaps. The console presents those gaps separately in Overview's right-side Record saving card.

## Migration

1. Rebuild and restart the management profile. Review any explicit archive interval overrides in its `aspera-dispatch` configuration; existing values still take precedence. Custom fleet callers that supply a resolved archive policy must include `archiveBacklogIntervalMs` and `archiveWaitingIntervalMs`.
2. Consumers of `lastSyncedAt` must treat it as a successful check time, not evidence of new output. Use `savedBytes` and source cursors for copied content. Read `gaps` and source gaps independently of current synchronization activity.
3. Verify the right-side card retains its timestamp during background work, shows historical gaps independently, and permits Sync now after final copying. See [local running records](../../../../extensions/aspera/docs/state-and-api.md#local-running-records) for configuration and ownership.
