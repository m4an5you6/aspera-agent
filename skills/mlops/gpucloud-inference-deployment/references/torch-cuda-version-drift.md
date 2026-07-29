# Torch / CUDA Version Drift

Lesson from deploy failures where torch was pinned to one CUDA wheel tag,
then an **unpinned or ranged** vLLM install replaced torch with a different
CUDA build — or where agents mixed a new vLLM binary with an old torch via
`--no-deps`.

## Failure pattern A — accidental resolver drift

1. `nvidia-smi` reports CUDA **12.4** (driver capability).
2. Agent installs `torch==2.5.1+cu124` into `inference_venvs/cu124` — smoke OK.
3. Agent then runs `pip install "vllm>=0.8.0"` (or bare `vllm` / loose range).
4. Resolver pulls a recent vLLM that **depends on** `torch` built for **cu128/cu130**.
5. Pip upgrades/replaces the pinned torch without a planned cu-tag change.
6. CUDA smoke / NCCL fails (or serve never starts); turns are spent on
   downgrade loops.

## Failure pattern B — intentional arch upgrade done wrong

1. Arch floor needs vLLM ≥0.17 → wheel expects `torch==2.10.0` (cu126/cu128).
2. Agent keeps `torch 2.5.1+cu124` and installs `vllm==0.17` with `--no-deps`.
3. Shallow `import vllm` may look fine; deep import / registry hits
   `undefined symbol` in `_C.abi3.so` (ABI mismatch).
4. Agent then claims “driver cannot run CUDA 12.8” without ever installing
   cu128 torch or seeing `insufficient driver` / PTX errors.

Correct path when arch forces a newer torch: **new venv tag**, exact
`torch==…+cuXXX` from `download.pytorch.org/whl/cuXXX`, CUDA smoke, then
exact `vllm==…`. See `vllm-torch-version-index.md` (arch wins over preferred
cu124 match; prove with smoke — do not pre-BLOCK).

## Rules

- After choosing the **planned** torch CUDA tag (preferred match **or**
  intentional upgrade for arch), pin **exact** versions:
  `torch==…+cuXXX`, `vllm==…` (never `>=`, never bare package names).
- Install / confirm **torch first**, then **vLLM**. Re-run CUDA smoke after
  each install that can touch torch.
- Prefer China PyPI mirrors for the main index; use
  `download.pytorch.org/whl/cuXXX` only as `--extra-index-url` for CUDA wheels.
- Do **not** use `--no-deps` to paste a newer vLLM onto an older torch.
- Accidental drift (unpinned vLLM swapping cu tags) is forbidden. Intentional
  cu-tag upgrade for arch is allowed and must be written in `compat_chain`
  rationale + `rejected_alternatives`.
- Do not assume “newer vLLM = better” for a given driver. Reject **ranges**;
  do not reject an exact cu128 plan solely because `nvidia-smi` prints 12.4.

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

Pin choice: arch floor first, then preferred or intentional cu tag — see
`references/vllm-torch-version-index.md`.
