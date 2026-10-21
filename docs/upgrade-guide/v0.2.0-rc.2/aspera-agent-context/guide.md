---
kind: upgrade-guide
description: "Aspera phase Agents own DSH compaction in their private model scopes and terminate unfinished token-limit stops as blocked."
---

# Aspera phase Agent context

English | [中文](guide.zh.md)

## Change

Aspera's preparation, planning and execution Agents mount published DSH compaction and tool-result pruning beside each phase's saved model provider. The root worker compactor cannot resolve an experiment-only provider such as `qwen-chat`; it is disabled. `agentContext.compaction` and `agentContext.pruning` configure the phase services through DSH's schemas and defaults. Summarization settings must identify the experiment's saved provider and model, including matching model-policy overrides; conflicting settings refuse Agent creation.

An unfinished planning or execution turn ending with `max-tokens` persists a blocked Goal and terminal worker outcome instead of remaining idle while the experiment displays running. The coordinator retains managed-process reconciliation; commands are not replayed. Protocol 4, fleet generation 6, approved plans, hardware requirements and Session formats remain unchanged.

## Migration

1. Update application resources and runtime dependencies together. The desktop resource updater preserves the existing executable. Custom callers may pass resolved `PhaseContextPolicy` to `openPhaseModelContext` or the `agentContext` argument of `ExperimentFleet.open`; omitted settings use published defaults.
2. Configure preparation in the management profile's `aspera-dispatch.agentContext`. Configure remote phases in `aspera-runtime.agentContext`; the coordinator forwards resolved settings to worker children through `DSH_CLUSTER_CONTEXT_POLICY_JSON`. Preserve private phase credentials and remove conflicting summarization-provider/model overrides. See [context configuration](../../../../extensions/aspera/packages/runtime/README.md#use-this-package).
3. Keep submitted experiments on their original fixed releases. Resource updates do not restart an old worker or rewrite its outcome. Confirm release of old tasks before copying an experiment to deploy the corrected runtime; investigate historical numerical failures separately.
4. Validate with the [keyless worker replay](../../../../extensions/aspera/scripts/test-worker.mjs): pressure creates actual `compaction/summary` events through the private selected model, subsequent tools run, and the settled command starts once. A token-limit response writes `aspera-model-token-limit` and exits. Actual long GPU training remains a separate acceptance.
