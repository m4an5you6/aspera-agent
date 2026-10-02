---
name: swift
description: Prepare version-pinned MS-SWIFT training, evaluation and inference within an Aspera experiment.
---

# MS-SWIFT training and inference

Identify MS-SWIFT, the model and the selected release before installation. Read that release's [official ModelScope repository](https://github.com/modelscope/ms-swift) and [documentation](https://swift.readthedocs.io/en/latest/) for model support, data format and command arguments. Record the version and URLs in the plan; do not reuse flags from another release without checking them.

Create an experiment-local environment with compatible Python, PyTorch, CUDA and model dependencies. Confirm whether the task needs full tuning, LoRA or another method from its requirements and resource limits. Inspect tokenizer templates, dataset schema, train/evaluation separation and preprocessing before launching.

Choose batch size, accumulation, sequence length, precision, checkpointing and learning-rate schedule from the model and data constraints. Run a small training and evaluation sample, measure memory and actual loss, and adjust within the approved limits. Record the full launch command, actual package versions, dataset digests and evaluation output.

When several nodes are selected, verify the release's distributed launcher and backend, stable ranks and rendezvous, then run a collective communication check. A requested Megatron backend requires its own compatible installation; the MS-SWIFT package alone does not establish that compatibility. Report unsupported model or network requirements as blocked.

Verify adapter merge requirements and checkpoint loading before inference. Keep the inference process registered independently of the Agent, bound to loopback, with a working health check. Save the model or adapter path, parameters and measured results with the experiment execution tool.
