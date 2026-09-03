# Isolating "degenerate output" from a transformers + bitsandbytes serve path

When a transformers-based serve/verify emits degenerate text (single
characters, `<|im_end|>`/newline loops, 128 tokens with NO EOS, repeated
system-prompt fragments), run this isolation ladder BEFORE touching the
adapter or re-exporting. Each rung rules out one layer of the stack. Live
example: kimi_vl 4-bit under transformers 5.12.1 (2026-08-07, FINAL RESOLUTION
at the bottom — the ladder is the reusable part).

## The ladder (each rung is a script, run with output to a FILE)

1. **Base-only control** — load base WITHOUT adapter, same prompts
   (`base_only_test.py`). Degenerates too → inference path, NOT the adapter.
2. **Prefill logits sanity** (`debug_4bit.py`): quantized-layer census
   (`isinstance(m, bnb.nn.Linear4bit)` — in transformers 5.12.1 the class is
   `bnb.nn.Linear4bit`, NOT `transformers.integrations.bitsandbytes.Linear4bit`
   which no longer exists) + parameter dtype census + one prefill forward
   printing logits `nan/inf/min/max/mean/std` + top-8 tokens + entropy.
   Healthy logits (no NaN, sensible top-k like "You/Okay/But") means the
   forward is sound → suspect the generation loop or precision, not load.
3. **Manual decode vs generate()** (`manual_vs_gen.py`): hand-rolled greedy
   loop (argmax + cat input_ids/attention_mask), with and without
   `past_key_values`, vs `model.generate()` with `use_cache=True/False`.
   If manual decode ALSO degenerates, generate() internals are exonerated —
   the forward itself is length- or precision-sensitive.
4. **Cache A/B** (`cache_ab_test.py`): same model+prompt,
   `use_cache=True` vs `False`. Both degenerate → KV-cache path ruled out.
5. **Per-step top-k + entropy dump** (`step_debug.py`): greedy rollout of
   8-10 steps, printing top-5 logits + entropy each step. Locates the EXACT
   divergence step. Live finding: steps 0-2 produced "You are an" with sane
   entropy (5.8 → 0.5 → 2.4), step 3+ collapsed to `<|im_end|>`/newline
   loops — so a 3-step smoke test can look healthy while real generation is
   broken. Always run ≥ 8 steps.

Signature to recognize: outputs that start by copying the system prompt
("You are you." / "you are a helpful assistant. You you may help...") are the
model latching onto prompt tokens after attention/logit corruption — not a
sampling fluke.

## Interpreting results

- Ladder says forward is sound (2/3/4 pass or reproduce) AND step-debug shows
  a late-token collapse → two candidate causes left: (a) quant precision on a
  precision-sensitive architecture, (b) transformers-version incompatibility
  with a legacy trust_remote_code modeling file. Distinguish by running the
  SAME quantized weights on a different transformers major (see below).
- **kimi_vl FINAL RESOLUTION (2026-08-07 night)**: the "4-bit degrades"
  conclusion from rungs 1-4 was WRONG — the degradation was transformers
  5.12.1's incompatibility with the legacy remote-code modeling file. The
  SAME 4-bit weights generate CORRECTLY (◁think▷ preserved, sensible
  answers) on transformers 4.46.3 + bitsandbytes 0.45.4 in a dedicated venv.
  Recipe: `references/kimi-vl-transformers-46-serve.md`. Lesson: before
  blaming quantization precision, try the model's era-correct transformers
  major in a separate venv — legacy `trust_remote_code` files and
  transformers 5.x fight over generate-path APIs, not just 4-bit numerics.
- **8-bit is not a free fallback on a 32GB-RAM box**: bnb 8-bit load reads
  the full bf16 weights into CPU RAM for quantization; the SYSTEM OOM killer
  SIGKILLs mid-load (bash prints bare `Killed`, no traceback, no EXIT line —
  distinguish from a torch `OutOfMemoryError` traceback = GPU). Check
  `free -g` before budgeting 8-bit.

## Scripts (all on this box under /home/ubuntu/remote_work/)

`base_only_test.py`, `debug_4bit.py`, `manual_vs_gen.py`, `cache_ab_test.py`,
`step_debug.py` — each is self-contained (loads 4-bit base, prints to stdout;
run with `> log 2>&1; echo EXIT=$? >> log` in background).

## GPU-contention note

On a shared box a peer agent session may be running the same diagnostics and
re-launching after every exit (its stdout lost in a pipe). Hand-polling
loses the race; use a standalone grab script that requires free memory
>22000 MiB AND a 60s stability window before launching
(`gpu_grab_8bit.sh` pattern, 2026-08-07).
