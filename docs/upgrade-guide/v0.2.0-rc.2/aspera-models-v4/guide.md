---
kind: upgrade-guide
description: "Aspera 0.1.1 requires three model selections for new experiments and writes protocol and storage generation 4."
---

# Aspera phase models and management interface

English | [中文](guide.zh.md)

## Change

Aspera remains `0.1.1` with DSH `0.2.0-rc.2`. New experiments use protocol and storage generation 4. Preparation, planning and execution each have immutable provider settings and a private credential snapshot. The create API requires explicit `models` selections; the dispatch tool requires `models_json`. Missing credentials and unsupported authentication reject submission, without switching to DeepSeek.

The release includes two pinned package patches for the grouped sidebar slot and the existing settings-command invocation. Generated Remote consumers and desktop installations must use the complete matching build. Agent records now have phase/Session/sequence cursors; process logs have node/command/stream/generation cursors.

## Migration

1. Keep the previous application directory and remote release while its experiments run. Upgrade a node control service only after its tasks finish and process cleanup is confirmed. Never run both control versions against the same state directory.
2. Install the complete new build, including `patches/` and its lockfile. Run the frozen dependency install and rebuild generated Remotes for separately maintained consumers. Check the build identifier; the application version alone does not distinguish these builds.
3. Open **Aspera model settings**, manage existing DSH accounts and choose all three Agent models before creating an experiment. API addresses, options and credentials are saved independently of subsequent global configuration changes.
4. Copy unfinished generation-1–3 preparations into new experiments. Historical records retain their original version values, hashes and model records; old receipts naming `0.2.0` are not relabeled.
5. Verify the selected models in experiment details and inspect preparation, planning and execution records separately. Raw keys and provider headers must remain absent from browser records and receipts. See the [state/API reference](../../../../extensions/aspera/docs/state-and-api.md) for ownership and compatibility.
