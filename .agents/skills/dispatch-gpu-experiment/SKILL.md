---
name: dispatch-gpu-experiment
description: Use when a local DSH goal must prepare a GPU server or container, deploy the current DSH source, and hand off an unattended training experiment.
---

# Dispatch a GPU experiment

Use the `experiment-dispatch` profile from the local DSH checkout. The target SSH identity, known host, remote root, and experiment token reference must already be configured. Keep secrets out of the goal text.

1. Read the user's objective and distinguish the Agent model from the model to train. Preserve explicit model, dataset, training method, hardware, and output constraints; select unspecified details only from authorized local data and remote resources.
2. Call `prepare_experiment_environment`. Treat its version digest, file restriction probe, and CUDA allocation result as the prerequisite for submission. A failed probe is a blocker; never switch to unrestricted execution to make the task run.
3. Call `submit_experiment` with the returned preparation id and the experiment requirements. Local files under configured data roots are staged before the remote receipt; remote workspace references must already exist. Save the returned submission, Session, and Goal ids.
4. Once the receipt contains a Goal id, finish the local goal as **remote worker accepted the task**. A lost-reply retry may return an already terminal remote state; report that state accurately. The remote Goal owns training, logs, and artifacts even after the local process exits.
5. Use `get_experiment_status` for later inspection and `cancel_experiment` only when the user or goal explicitly requests cancellation. Report failures and authorization limits without waiting for a human answer in this run.
