# Megatron Core FP8 compute and communication

This capability map is scoped to the source inspected in 2026-08 for Megatron
Core 0.16.1 and Transformer Engine 1.12.0. Source fields show that a path
exists; they do not prove that the installed CLI exposes it or that the current
GPU, Transformer Engine, NCCL, and torch stack can execute it.

## Keep three concepts separate

1. **FP8 compute:** selected GEMMs use FP8 inputs with scaling.
2. **FP8 communication:** distributed collectives transmit an FP8 payload.
3. **FP8 checkpoint:** model or adapter tensors are persisted in FP8 with
   enough metadata to reconstruct their values.

Enabling one does not imply the other two. In particular,
`--fp8-format` does not prove that exported LoRA tensors are FP8.

## Validated source-level capability

| Path | Megatron Core 0.16.1 observation |
|---|---|
| TP/SP activation all-reduce, all-gather, reduce-scatter | No integrated FP8 payload path found in the inspected implementation; validated runs kept BF16 communication |
| MoE token dispatch/combine all-to-all | FP8-related buffer hooks existed, but the dispatcher explicitly disabled FP8 dispatch |
| Distributed-optimizer parameter all-gather | FP8 parameter-gather configuration existed; runtime support remained recipe- and hardware-dependent |
| Transformer Engine GEMMs | FP8 compute paths existed; this did not reduce ordinary TP/SP activation traffic |

These conclusions are version-specific. Re-inspect after an upgrade.

## TP/SP activation communication

The inspected TP/SP collectives did not quantize activation payloads. FP8
Transformer Engine GEMMs therefore did not solve a cross-node TP activation
bandwidth bottleneck.

Communication overlap can hide part of the cost but does not reduce the
payload precision. Measure end-to-end step time rather than inferring savings
from a compute dtype flag.

## MoE all-to-all

The inspected HybridEP path exposed FP8-oriented buffer parameters, while its
forward path forced FP8 dispatch off and asserted that the mode was
unsupported. Do not patch this guard based only on datatype availability:
correct token scales, routing metadata, combine behavior, and backward
semantics all need an implementation and distributed tests.

## Distributed-optimizer parameter gather

The inspected optimizer configuration exposed FP8 parameter-gather and MXFP8
related fields. Before enabling them, verify:

- the CLI accepts the corresponding flags;
- the selected Transformer Engine recipe exists;
- the GPU architecture provides the required native datatype support;
- optimizer state, master-parameter, and checkpoint semantics are understood;
- a bounded distributed smoke test passes;
- measured communication and convergence match expectations.

MXFP8 is hardware-specific. The presence of its configuration in source is not
evidence that it is usable on RTX 3090/Ampere. Do not advertise FP8 speed or
communication savings on hardware without native support.

Even when enabled, parameter gather is only one communication category. It
does not change TP/SP activation collectives or MoE token dispatch.

## How to verify another installed version

1. Resolve the active interpreter and package locations instead of assuming a
   venv path.
2. Record Megatron Core, Transformer Engine, torch, CUDA runtime, NCCL, GPU
   model, and driver versions.
3. Check CLI help or the actual argument-generation code.
4. Trace configuration fields to their consumers; a declaration with no
   executable consumer is not support.
5. Inspect collective call sites and the tensor dtype immediately before the
   collective.
6. Run a bounded multi-rank smoke test and measure payload/step behavior.

Useful search terms include:

```text
fp8_param_gather
fp8_recipe
reuse_grad_buf_for_mxfp8_param_ag
fp8_dispatch
use_fp8
all_reduce
all_gather
reduce_scatter
all_to_all
```

Megatron Core 0.16.x defines many arguments through dataclass configuration
objects rather than a single `core/arguments.py`; inspect the installed
package layout before searching.

## Relation to FP8 LoRA

An FP8 training recipe may use FP8 GEMMs while keeping trainable LoRA
parameters and exported adapters in BF16 or FP32. Inspect the actual checkpoint
instead of inferring its dtype from launch flags.

For a genuine FP8 LoRA checkpoint:

- verify tensor or block scales and their granularity;
- dequantize through the producing format;
- keep the adapter separate from the base;
- if the serving backend lacks native FP8 adapter support, convert only the
  adapter to BF16 and load it dynamically;
- do not merge small low-precision deltas into a BF16 base.

Validate the unmerged adapter from its effective branch or deterministic
base-vs-adapter logits, not from a universal raw-weight threshold.
