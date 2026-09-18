# Gemma4 Unified support notes

This reference describes the validated 2026-08 environment for
`google/gemma-4-12B`. Re-check installed versions and model configuration
before applying the conclusions to another Gemma4 release.

## Model identity

- HF `model_type`: `gemma4_unified`
- HF architecture: `Gemma4UnifiedForConditionalGeneration`
- Text configuration: 48 layers, hidden size 3840, 16 attention heads, 8 KV
  heads, vocabulary 262144, tied embeddings, and interleaved sliding/global
  attention.
- Sliding layers use `head_dim=256`; global layers use
  `global_head_dim=512`. This mixed dimension is the source of the training
  and checkpoint issues documented below.
- Text-only SFT uses `--language_model_only true`; the validated plain-chat
  template is `gemma4_nothinking`.

Read these values from the local `config.json`; do not identify the model from
its directory name alone.

## Support matrix

### Megatron / mcore-bridge

mcore-bridge 1.6.1 contains entries for `gemma4` and
`gemma4_unified`, so the model is recognized without model-type ambiguity.
That is registration support, not an end-to-end guarantee.

With Swift 4.4.2, Megatron Core 0.16.1, and Transformer Engine 1.12.0,
`gemma4_unified` required three fixes in
`mcore_bridge/model/mm_gpts/gemma4.py` before TP=2 LoRA training and
checkpoint save were reliable:

1. split mixed QKV along dimension 3;
2. make a TP-sliced query contiguous before TE RMSNorm;
3. enable heterogeneous distributed checkpoint keys for mixed head dimensions.

See [gemma4-unified-training.md](gemma4-unified-training.md) for the exact
version-scoped patches and launch constraints. Apply patches identically on
every rank and record the package version and patched-file checksum.

### vLLM 0.19.1

The validated vLLM registry did not contain a native
`Gemma4UnifiedForConditionalGeneration` entry. A TP=1 attempt still reached
weight loading through a fallback path and then exhausted a 24 GB GPU; this
does not establish supported serving.

Measured limitations for this model and version:

- TP=1 BF16 exceeded 24 GB VRAM.
- TP=2 failed in a model-internal reshape.
- TP=2 with LoRA also failed in the LoRA/Punica initialization path.

Therefore vLLM 0.19.1 is not a validated Gemma4 Unified LoRA backend. Re-test
newer versions rather than treating this historical result as permanent.

### Transformers + PEFT

Transformers 5.12.1 could load the validated Gemma4 Unified model and an
adapter through PEFT. On a 24 GB device, use an appropriate memory strategy
such as a supported 4-bit base or deliberate CPU offload.

Keep the adapter separate:

```python
base = AutoModelForCausalLM.from_pretrained(BASE, ...)
model = PeftModel.from_pretrained(base, ADAPTER)
# Do not call merge_adapter() or merge_and_unload().
```

Prompt formatting must come from the model artifact or its official model card.
Check both tokenizer and processor metadata. If neither provides a chat
template, use the model's documented turn format; do not invent one.

## LoRA handoff

Prefer adapter-only export:

```text
megatron export --to_hf --merge_lora false
```

Validate `adapter_config.json`, adapter keys, rank, alpha, target modules,
finite tensors, and a deterministic base-vs-adapter output difference. Do not
judge quality from a universal absolute-weight threshold.

If the exported adapter is genuinely FP8:

- retain and validate its tensor/block scale metadata;
- dequantize with the producing format;
- load it as a separate adapter branch;
- if necessary, save a BF16 **adapter-only** copy for PEFT;
- do not merge the delta into a BF16 base.

The single-GPU 4-bit fallback quantizes the base at load time. It does not imply
that training used QAT or that the LoRA checkpoint itself is 4-bit.
