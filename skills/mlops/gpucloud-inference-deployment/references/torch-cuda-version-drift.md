# Torch / CUDA Version Drift

Lesson from deploy failures where torch was pinned to the driver CUDA tag,
then an unpinned or ranged vLLM install replaced torch with a newer CUDA build
the driver cannot run.

## Failure pattern

1. `nvidia-smi` reports CUDA **12.4** (driver capability).
2. Agent installs `torch==2.5.1+cu124` into `inference_venvs/cu124` — smoke OK.
3. Agent then runs `pip install "vllm>=0.8.0"` (or bare `vllm` / loose range).
4. Resolver pulls a recent vLLM that **depends on** `torch` built for **cu128/cu130**.
5. Pip upgrades/replaces the pinned torch. CUDA smoke fails
   (`CUDA error` / incompatible runtime vs driver).
6. Ray / serve never starts; turns are spent on downgrade loops.

## Rules

- After choosing torch CUDA tag from the **driver**, pin **exact** versions:
  `torch==…+cuXXX`, `vllm==…` (never `>=`, never bare package names).
- Install / confirm **torch first**, then **vLLM**. Re-run CUDA smoke after
  each install that can touch torch.
- Prefer China PyPI mirrors for the main index; use
  `download.pytorch.org/whl/cuXXX` only as `--extra-index-url` for CUDA wheels.
- Do not assume “newer vLLM = better” for a given driver. Reject ranges that
  can float onto incompatible torch CUDA tags (record them in
  `rejected_alternatives` on the compat chain).

## Related: libnccl drift on multi-node

An unpinned / ranged vLLM install can also replace
`site-packages/nvidia/nccl/lib/libnccl.so.2` with a **cuda13** NCCL (e.g.
`2.28.9+cuda13.0`) while `pip show nvidia-nccl-cu12` still claims an older
version. Cross-node NCCL then fails with
`CUDA driver version is insufficient for CUDA runtime version` even when
single-GPU `torch.cuda` works and Gloo/Ray succeed.

Always verify the `.so` with `strings` on **every** rank before multi-node
TP. Details: `references/multinode-nccl-and-lib-drift.md`.

## Compat chain

Before any torch/vLLM pip, call `inference_ensure_runtime` with a full
`compat_chain` (`status=planned`). After install + smoke, call again with
`status=verified`. Ray and `inference_start_vllm` refuse work until verified.

See skill procedure and `inference_ensure_runtime` schema for required fields.
