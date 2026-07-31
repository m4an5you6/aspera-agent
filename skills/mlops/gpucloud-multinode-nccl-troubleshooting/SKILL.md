---
name: gpucloud-multinode-nccl-troubleshooting
description: Diagnose and resolve NCCL cross-node communication failures in vLLM multi-node TP deployments.
version: 1.0.0
author: GPUCLOUD
platforms: [linux]
metadata:
  gpucloud:
    tags: [nccl, vllm, multi-node, tensor-parallel, debugging]
    triggers:
      - nccl error
      - unhandled cuda error
      - cross-node nccl
      - multi-node vllm fail
---

# Multi-node NCCL Troubleshooting for vLLM

## When to Use
- vLLM TP>1 across nodes fails with `RuntimeError: NCCL error: unhandled cuda error`
- `ncclCommInitRank` fails on remote Ray workers
- NCCL_DEBUG output only appears on local worker, never on remote

## Cross-node Package Consistency (mandatory before multi-node vLLM)

`pip` dependency resolution silently upgrades packages across nodes, causing
subtle failures that look like NCCL or model-load errors. After ANY pip install
on a worker, re-verify the full stack.

### Verification checklist (run on every node)
```bash
PY="$HOME/.cache/gpu_platform/inference_venvs/cu124/bin/python"
$PY -c "import torch,vllm,ray; print('torch',torch.__version__); print('vllm',vllm.__version__); print('ray',ray.__version__)"
$PY -c "import transformers; print('transformers', transformers.__version__)"
$PY -c "import click; print('click', click.__version__)"
# NCCL binary match (not pip show — metadata can lie)
strings "$HOME/.cache/gpu_platform/inference_venvs/cu124/lib/python3.10/site-packages/nvidia/nccl/lib/libnccl.so.2" | grep -F 'NCCL version' | head -1
```

### Pinning against drift
After installing the correct version, subsequent `pip install` calls can
re-upgrade packages through transitive dependencies. Use `--force-reinstall --no-deps`
for critical pins (torch, vllm, ray, click) to prevent resolver from pulling
newer versions. Example sequence for CUDA 12.4 (Qwen3.6 MoE fallback):

```bash
PIP="$HOME/.cache/gpu_platform/inference_venvs/cu124/bin/pip"
MIRROR="-i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn"
# Torch first — Tsinghua serves cu124 wheels directly (no --extra-index-url)
$PIP install "torch==2.6.0+cu124" $MIRROR
# vLLM with --no-deps prevents resolver from upgrading torch
$PIP install "vllm==0.8.3" --force-reinstall --no-deps $MIRROR
# vLLM without --no-deps will pull its own deps (transformers, xgrammar, etc.)
# but may also pull a newer ray — verify after and re-pin if needed
$PIP install "vllm==0.8.3" --force-reinstall $MIRROR
# Pin click after any ray-affecting install
$PIP install "click==8.1.7" --no-deps $MIRROR
# If ray version changed, re-pin
$PIP install "ray==2.56.1" --force-reinstall --no-deps $MIRROR
```

### Observed drift patterns
- `pip install ray==2.40.0` → resolver upgrades vllm 0.7.3 → 0.8.2
- `pip install vllm==0.7.3` → resolver upgrades torch 2.5.1 → 2.6.0  
- `pip install click==8.1.7` → next `pip install ray` upgrades click → 8.4.2
- `pip install vllm==0.8.3` on worker with torch 2.5.1 → vLLM installed but
  C extensions fail with `undefined symbol: _ZNK3c1011StorageImpl...` at import
- `pip install vllm==0.17.0` → resolver pulls torch 2.10.0 (cu128) replacing
  cu124 torch → `libcusparseLt.so.0` / `libnvshmem_host.so.3` missing at import
- `pip install vllm==0.17.1` on a worker that had 0.17.0 → resolver upgrades
  openai 2.24.0 → 2.50.0. Downgrading back to vllm==0.17.0 with `--no-deps`
  leaves openai at 2.50.0 but strips its transitive deps (`distro`, `jiter`,
  `sniffio`, `diskcache`). Result: Ray workers fail with
  `ModuleNotFoundError: No module named 'distro'` (or `jiter`, `sniffio`,
  `diskcache`) in `vllm/entrypoints/mcp/tool.py` → `openai/_base_client.py`
  import chain. Fix: either reinstall openai==<head_version> with deps, or
  install the missing transitive deps explicitly on the affected worker.
- **Result**: `ParallelConfig.world_size_across_dp` AttributeError on worker,
  or Ray CLI `copy.deepcopy` Sentinel ValueError, or torch import failure from
  version drift

## Root Cause (observed on Qwen3.6-35B-A3B MoE, RTX 3090, CUDA 12.4)
vLLM 0.7.3 RayDistributedExecutor only propagates a whitelist of env vars
(VLLM_*, TPU_*) to remote Ray workers via `update_environment_variables` RPC.
NCCL vars (NCCL_SOCKET_IFNAME, NCCL_IB_DISABLE, etc.) are excluded.

## Attempted fixes (all failed for this specific cross-node setup)
1. System-wide /etc/environment on both nodes
2. Shell export before `ray start`
3. vLLM source patch to whitelist NCCL vars in `ray_distributed_executor.py:315`
4. vLLM source patch to inject vars via `ray_remote_kwargs["runtime_env"]["env_vars"]`
5. NCCL_NET=Socket, NCCL_P2P_DISABLE=1, NCCL_IB_DISABLE=1

## What worked
Reporting phase=start failure and recommending single-node TP=1 or Gloo backend.

## vLLM + bitsandbytes + LoRA + MoE OOM Deadlock

On RTX 3090 (24GB) with Qwen3.6-35B-A3B (35B MoE):
- vLLM 0.7.3 creates model layers at **full precision** during `__init__` before
  applying bitsandbytes quantization → ~35GB/GPU needed during init, 24GB available → OOM
- `cpu_offload_gb` is blocked by vLLM 0.7.3 when `enable_lora=True`
  (`ValueError: CPU offload is not supported with LoRA yet`)
- vLLM 0.8.x fixes lazy bnb init (avoiding the 0.7.3 full-precision peak-OOM)
  but 0.8.0–0.8.2 pin unpublished `xgrammar==0.1.16` (landmine). Prefer
  vLLM 0.8.3 which pins `xgrammar==0.1.17`. For CUDA 12.4 drivers, vLLM
  0.8.3 + torch 2.6.0+cu124 is a viable combination (both available on
  Tsinghua mirror). vLLM ≥0.15.0 requires torch ≥2.9.1 (cu128+) and is
  incompatible with CUDA 12.4 drivers without a driver upgrade.
- **Resolution**: larger GPU (48GB+) or driver upgrade to ≥570 (CUDA 12.8+)
  with vLLM 0.17+ for native Qwen3.6 MoE; **or** vLLM 0.8.3 + Transformers
  fallback for CUDA 12.4 drivers.

## Pitfalls

- `ray start` on Python 3.10 with click>=8.4.2 breaks with `ValueError: <object object at ...> is not a valid Sentinel` during `copy.deepcopy(command)` in `ray/scripts/scripts.py:add_command_alias`. Fix: `pip install click==8.1.7 --no-deps`.
- vLLM 0.7.3 requires ray==2.40.0 but ray 2.40.0 pulls click 8.4.2 via `click>=8.1.7`. Always pin click separately after any Ray install.
- transformers 5.14.1 removes `all_special_tokens_extended`; vLLM 0.7.3 needs
  transformers 4.51.0–4.54.x. Align transformers across nodes; 4.54.0 is the
  latest compatible with vLLM 0.7.3 and has `_experts_implementation_internal`.
- Node1 may have different vLLM version (e.g., 0.8.2 vs 0.7.3) causing
  `ParallelConfig.world_size_across_dp` mismatch on Ray workers.
  Always verify with `pip show vllm` after installs, not just `import vllm`.
- **Ray major version mismatch**: workers with ray 2.40.0 cannot join a head
  running ray 2.56.1 (or vice versa). Symptom: `ConnectionError: Could not
  read 'temp_dir' from GCS` on worker even though TCP to head port is open.
  Fix: upgrade workers to the same ray version as the head
  (`pip install ray==<head_version> --force-reinstall --no-deps`), then
  re-pin click==8.1.7. After upgrade, re-verify all 4+ nodes in `ray status`.
- **Pre-existing Ray clusters**: before starting a fresh Ray head, run
  `ray stop --force` then `rm -rf /tmp/ray` to clean leftover state from
  previous deployments. Lingering GCS/raylet processes from old sessions
  cause port conflicts and node registration failures.
- **Torch ABI mismatch (vLLM 0.8.3 + torch 2.5.1)**: vLLM 0.8.3 C extensions
  are compiled against torch 2.6.0's libtorch ABI. Installing vLLM 0.8.3 on a
  worker that still has torch 2.5.1+cu124 produces:
  `ImportError: /.../vllm/_C.abi3.so: undefined symbol: _ZNK3c1011StorageImpl27throw_data_ptr_access_errorEv`
  Fix: upgrade torch on that worker to 2.6.0:
  `pip install torch==2.6.0 --force-reinstall -i <tsinghua>`. After upgrade,
  re-verify torch+vllm import on the worker. **Never** skip the torch version
  check after vLLM install — pip's `--no-deps` for vLLM means the existing
  (possibly wrong) torch remains untouched.
- **Corrupted torch from version drift**: a previous unpinned vLLM install
  (or torch upgrade) can leave torch in a broken state where `import torch`
  fails with `libcusparseLt.so.0: cannot open shared object file` or
  `libnvshmem_host.so.3: cannot open shared object file`. The `pip show torch`
  may report a version like 2.10.0 that is incompatible with the installed CUDA
  libraries. Fix: force-reinstall the correct torch:
  `pip install torch==2.6.0 --force-reinstall -i <tsinghua>`. Verify with
  `python -c "import torch; print(torch.__version__, torch.cuda.is_available())"`.
- **Full vLLM reinstall replaces torch silently**: `pip install vllm==X.Y.Z
  --force-reinstall` (without `--no-deps`) can pull a non-CUDA torch from PyPI
  (e.g. `torch-2.10.0-cp310-cp310-manylinux_2_28_x86_64.whl` without `+cu128`).
  After any full vLLM reinstall, verify `torch.__version__` ends with `+cuXXX`
  and re-pin torch with `--extra-index-url https://download.pytorch.org/whl/cuXXX`
  if needed.
- **Worker missing base HF model**: Ray workers load model shards from their
  own filesystem. A worker without the base model produces
  `huggingface_hub.errors.HFValidationError: Repo id must be in the form
  'repo_name' or 'namespace/repo_name': '/path/to/model'` — not a clear
  "file not found". This looks like a path-parsing error but means the model
  directory simply doesn't exist on that worker. Fix: sync the model tree
  (`rsync` / `tar` pipe) to every worker before starting vLLM.
  Verify with `ls <model_path>/config.json` on each worker via SSH.
- Tsinghua mirror works for torch; Aliyun mirror with pytorch.org extra-index
  is too slow for torch CUDA wheel downloads.
- **HF custom module cache**: models with `auto_map` in config.json (e.g., Qwen3.5
  MoE) cache custom `.py` files in `~/.cache/huggingface/modules/transformers_modules/`.
  Workers may have incomplete caches (missing `configuration_*.py`). Fix:
  copy the file from the model directory into the HF cache hash dir. Symptom:
  `ModuleNotFoundError: No module named 'configuration_qwen3_5_moe'` on
  Ray worker even though the file exists in the model directory.
- **NCCL smoke scripts**: `torch.distributed.Timedelta` does not exist in
  torch 2.5.x. Use `from datetime import timedelta` and pass
  `timeout=timedelta(seconds=N)` instead. Also add `flush=True` to all
  `print()` calls in NCCL smoke scripts so output appears before the
  process hangs or crashes.

## References

- `references/nccl-smoke-script.md` — proven NCCL smoke test script with Gloo+NCCL allreduce
