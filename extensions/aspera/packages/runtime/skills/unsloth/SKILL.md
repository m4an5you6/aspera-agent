---
name: unsloth
description: Prepare and evaluate version-pinned Unsloth fine-tuning and inference using an Aspera experiment's granted resources.
---

# Unsloth fine-tuning

Read the selected Unsloth release [documentation](https://unsloth.ai/docs) and [official repository](https://github.com/unslothai/unsloth) for supported model families, precision, kernels and hardware. Record the exact version or commit and documentation URL. Check distributed support for that release before promising a joint multi-node experiment; do not silently fall back to a single node.

Install compatible Python, PyTorch, CUDA, Triton and any quantization dependencies in the experiment workspace. Inspect tokenizer templates, dataset fields, train/evaluation separation and required access to model weights. Keep model downloads and caches in the granted directory.

Choose full tuning or adapters, quantization, sequence length, batch size, accumulation, checkpointing and optimizer from the requirements and measured memory. Run a short training sample and a held-out evaluation before starting the full training run. Record actual versions, script, environment, data digests, parameters and measured metrics.

Check how the saved adapter or checkpoint must be exported or merged for the selected inference engine. Verify a real sample prediction after loading that artifact. If serving is requested, register a managed loopback service with a health endpoint and preserve the experiment's server allocation until confirmed stop. Report unsupported models, kernels or resource requirements as blocked with the concrete failure.
