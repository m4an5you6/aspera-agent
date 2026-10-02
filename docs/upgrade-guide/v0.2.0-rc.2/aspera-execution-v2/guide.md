---
kind: upgrade-guide
description: Aspera v2 submissions remove aggregate budgets and add durable operator replies.
---

# Aspera execution v2

English | [中文](guide.zh.md)

## Change

The independent Aspera extension moves from 0.1 to 0.2 while keeping its published DSH dependency fixed. New submissions use protocol 2. Both execution modes omit task runtime, command, Goal-round and inference-service budgets. `defaultBudget`, `budget_json` and the four `defaultMax*` dispatch settings are removed. Semi mode can persist questions and receive replies through `answerExperimentQuestion`; automatic mode never waits for a human answer.

Protocol 1 submissions and their hashes remain readable. Their original release and limits remain authoritative. An interrupted experiment is reported without relaunching training; unresolved questions expire. The new runtime refuses to execute legacy submissions under the new policy.

Desktop builds produce the complete `win-unpacked` application directory and its build record. They no longer produce a ZIP.

## Migration

1. Finish or cancel experiments on the old remote release and confirm node cleanup before stopping its control processes. Install the new release in a separate content-addressed directory. Do not replace a busy controller or remove old releases and state.
2. Update callers of `createExperiment` and `dispatch_experiment` to omit budget fields. Remove `defaultMaxRuntimeSeconds`, `defaultMaxServiceSeconds`, `defaultMaxCommands` and `defaultMaxGoalRounds` from custom dispatch patches.
3. Configure `goalContinuationWindow` on the remote runtime when needed. It is a renewal interval, not a total task limit. Keep individual operation timeouts and confinement enabled.
4. Rebuild Aspera and its generated Remote descriptions. Confirm that a new receipt contains `protocol: 2`, that a semi-mode reply resumes the same Session and Goal, and that a v1 receipt still displays its original limits.
5. Open `win-unpacked/Aspera.exe` directly and retain all files in that directory. Use the [desktop API check](../../../../extensions/aspera/docs/verification.md#local-checks) with a state directory outside the checkout to verify the bundled plugin resolver.

See the [Aspera workspace](../../../../extensions/aspera/README.md) for startup and acceptance commands.
