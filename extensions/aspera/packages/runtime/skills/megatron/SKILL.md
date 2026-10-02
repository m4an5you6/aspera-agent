---
name: megatron
description: Prepare and evaluate version-pinned Megatron training on the servers assigned to an Aspera experiment.
---

# Megatron training

Read the chosen Megatron Core or Megatron-LM release documentation and examples before selecting commands. Start from the [official NVIDIA repository](https://github.com/NVIDIA/Megatron-LM) and its version documentation; record the exact tag or commit and documentation URL in the plan. Megatron Core is a library and Megatron-LM provides training entrypoints, so identify which the experiment needs.

Match Python, PyTorch, CUDA and NCCL to that release. Put the environment, downloads and scripts inside the experiment workspace. Verify model architecture, tokenizer, data format, license and available storage before installing or converting data. Record all package versions and the conversion script.

Derive tensor, pipeline and data parallel degrees from the assigned GPU count and model dimensions. Account for the global batch size, micro batch size, gradient accumulation, sequence length, activation memory and checkpoint space. Use a small measured run to check memory, loss, throughput and checkpoint load before longer training. If the requested model or batch cannot fit, report the measured reason and request a new experiment with revised constraints.

For joint execution, keep stable node ranks, a common rendezvous address and compatible environments on every selected node. Run a real collective communication check before distributed training. Do not substitute independent single-node runs for a requested multi-node run, remove nodes, or silently change training requirements.

Record framework commit, script, environment, parameters, data digests, checkpoint paths and evaluation metrics with the experiment execution tool. Check checkpoint format before proposing inference: conversion may be necessary for the selected serving engine. Register inference through the service tool with a loopback address and a real health endpoint.
