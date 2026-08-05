# Installing transformer_engine (TE) for ms-swift Megatron / mcore-bridge

Verified 2026-08 on China-network RTX 3090 (driver 550.142, CUDA 12.4 cap). Both single-node and
twin-node (identical hardware) builds.

## TE 1.x packaging (3 separate PyPI packages)

`transformer-engine` (metapackage) depends on:
1. `transformer_engine_cu12` — COMPILED core; wheel `transformer_engine_cu12-1.12.0-py3-none-manylinux_2_28_x86_64.whl` (~350-440MB, bundles CUDA libs; contains `libtransformer_engine.so`). `py3-none-manylinux` = NOT cp310-specific.
2. `transformer_engine_torch` — torch binding; on PyPI it is a small SDIST that COMPILES `transformer_engine_torch.cpython-310-x86_64-linux-gnu.so` at install time.
3. `transformer-engine` — thin python layer (`transformer_engine/pytorch/...` sources).

## Mirror sources (China)

- Prebuilt cu12 wheels + torch sdists ARE on regular PyPI mirrors: huawei (`mirrors.huaweicloud.com/repository/pypi/simple/`), sjtu, tuna, ustc all carry `transformer_engine_cu12` / `transformer_engine_torch`. aliyun and tencent pypi 404 these packages.
- The tuna JSON endpoint (`/pypi/transformer_engine_cu12/json`) 404s, but the tuna simple index page works.
- NGC pip index and CUDA runfiles are NOT usable from China (301 -> developer.nvidia.cn -> 404). See china-ml-environment skill.

## Version choice: use TE 1.12.0, NOT 1.13/2.x, on CUDA 12.4

- `transformer_engine_torch` 1.13.0 and 2.x source uses `cudaEmulation*` APIs present only in
  CUDA 12.5+/13 headers; on a CUDA 12.4 toolchain the compile errors with
  `identifier "cudaEmulationSpecialValuesSupport" is undefined`. **TE 1.12.0 is the verified
  version that compiles cleanly on nvcc 12.4** (its csrc uses only CUDA 12.0-12.4 APIs).
- The metapackage pins the cu12 core to the same version (`transformer-engine==1.12.0` -> `transformer_engine_cu12==1.12.0`); the cu12 wheel runs fine on driver 550.
- megatron-core 0.16.1 + mcore-bridge 1.6.1 work with TE 1.12.0 for the mcore_bridge qwen3_5 path (TE usage there is shallow: fp8 no-op contexts + `TEFusedMLP is not None` checks). Note: TE 1.12's `fused` attention does NOT support qwen3.5's GQA head_dim=256 (`ValueError: No dot product attention support for the provided inputs!`) — use `--attention_backend unfused` (see ms-swift-megatron-training).

## Getting nvcc 12.4 (the hard part — verified recipe)

- `pip install nvidia-cuda-nvcc-cu12` ships ONLY `ptxas` + headers in ALL versions (12.3..12.9); there is NO `nvcc` binary. Dead end.
- micromamba static binary segfaults on these VMs (`Segmentation fault` on `--version`). Dead end.
- CUDA toolkit runfile is blocked by the nvidia.cn redirect. Dead end.
- **Working: Miniconda from the TUNA anaconda mirror + conda create of the CUDA 12.4 compiler packages** (no sudo, installs to a prefix dir):

```bash
curl -sL -o /tmp/miniconda.sh "https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-latest-Linux-x86_64.sh"
bash /tmp/miniconda.sh -b -p /home/ubuntu/miniconda
export PATH=/home/ubuntu/miniconda/bin:$PATH
export CONDA_NO_PLUGINS=true   # conda 26 ships with a broken libmamba plugin reference
# conda 26 also forces Anaconda ToS for default channels -> ALWAYS use --override-channels with one explicit channel
conda create -p /home/ubuntu/cudatk -y --override-channels --solver=classic \
  -c https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main \
  "cuda-nvcc=12.4" "cuda-cudart-dev=12.4"
# conda env layout fix: headers live under targets/, not include/; nvcc expects $CUDA_HOME/include + lib64
mv /home/ubuntu/cudatk/include /home/ubuntu/cudatk/include.bak
ln -sfn /home/ubuntu/cudatk/targets/x86_64-linux/include /home/ubuntu/cudatk/include
ln -sfn /home/ubuntu/cudatk/lib /home/ubuntu/cudatk/lib64
/home/ubuntu/cudatk/bin/nvcc --version   # Cuda compilation tools, release 12.4, V12.4.131
```
- Channel notes: TUNA (`mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main`) serves real repodata; huawei's anaconda mirror returns HTML error pages for repodata (conda fails with `JSONDecodeError ... <!DOCTYPE html>`). Use `--solver=classic` (libmamba not installed) and `CONDA_NO_PLUGINS=true`.

## Building transformer_engine_torch (verified sequence)

Prereqs: `sudo apt-get install -y python3.10-dev` (Python.h), `uv pip install ninja`, and the
conda CUDA_HOME above. Then:

```bash
SP=$(python -c "import site; print(site.getsitepackages()[0])")
# CPATH must include every nvidia/*/include (cusparse.h, cublas_v2.h, cudnn.h, nccl.h ...)
INC=""; LIB=""
for d in "$SP"/nvidia/*/; do
  case "$d" in *"/cu13/"*) continue;; esac   # CRITICAL: exclude leftover cu13 dirs (see below)
  [ -d "$d/include" ] && INC="$INC:$d/include"
  [ -d "$d/lib" ] && LIB="$LIB:$d/lib"
done
export CPATH="${INC#:}" LIBRARY_PATH="${LIB#:}" LD_LIBRARY_PATH="${LIB#:}:$LD_LIBRARY_PATH"
export CUDA_HOME=/home/ubuntu/cudatk TORCH_CUDA_ARCH_LIST="8.6" MAX_JOBS=8
uv pip install --reinstall "transformer_engine_torch==1.12.0" --no-build-isolation
```

### Pitfall: leftover cu13 nvidia headers cause fake "TE needs newer CUDA" errors

After downgrading torch (e.g. 2.13.0+cu130 -> 2.6.0+cu124), the venv keeps `nvidia/*/cu13`
packages. If their include dirs land in CPATH they SHADOW the correct cu12 headers, and the
CUDA-13 `cublas_api.h` references `cudaEmulation*` types that nvcc 12.4 doesn't know:
```
/path/venv/lib/python3.10/site-packages/nvidia/cu13//include/cublas_api.h(285): error: identifier "cudaEmulationSpecialValuesSupport" is undefined
```
This looks like "TE needs CUDA 12.5+" but is actually header shadowing. Fix: uninstall the cu13
packages (`uv pip uninstall $(uv pip list | grep -i cu13 | awk '{print $1}')`) and/or exclude
`*"/cu13/"*` from CPATH.

### Pitfall: cu13 uninstall can break torch itself (shared dirs)

`nvidia-cudnn-cu13`/`nvidia-nccl-cu13`/`nvidia-cusparselt-cu13` install INTO the same
`nvidia/cudnn`, `nvidia/nccl`, `nvidia/cusparselt` dirs the cu12 packages use. Uninstalling the
cu13 ones deletes shared files, and `uv pip install nvidia-cudnn-cu12` then says "Checked 1
package" without restoring them -> torch import fails (`ImportError: libcudnn.so.9` / `libnccl.so.2` /
`libcusparseLt.so.0`). Fix in one shot: `uv pip install --reinstall <torch-2.6.0+cu124.whl>` —
reinstalls torch and all its nvidia cu12 deps consistently. Always re-verify `torch.cuda.is_available()` after any cu13 cleanup.

### Pitfall: uv build hangs AFTER the wheel is complete

`uv pip install --reinstall transformer_engine_torch...` may compile everything, write the wheel
(`transformer_engine_torch-1.12.0-cp310-cp310-linux_x86_64.whl` in `~/.cache/uv/sdists-v9/pypi/transformer-engine-torch/1.12.0/*/`), then hang with no compiler children and 0% CPU. Kill uv
(`pkill -9 -f "[u]v pip"`), then install the cached wheel directly:
```bash
uv pip install ~/.cache/uv/sdists-v9/pypi/transformer-engine-torch/1.12.0/*/transformer_engine_torch-1.12.0-cp310-cp310-linux_x86_64.whl --no-deps
```

### Twin-node shortcut (identical hardware)

The compiled `.so` is machine-arch-specific but identical across twin VMs: scp
`<venv>/lib/python3.10/site-packages/transformer_engine/transformer_engine_torch.cpython-310-x86_64-linux-gnu.so`
to the second node's same path, then on that node `uv pip install transformer_engine_cu12==1.12.0
transformer-engine==1.12.0` + the deps (ninja, python3.10-dev, qwen_vl_utils, torchvision,
flash-linear-attention). No rebuild needed.

## Install sequence that worked

```
uv pip install transformer_engine_cu12==1.12.0
uv pip install transformer_engine_torch==1.12.0 --no-build-isolation   # with the env above
uv pip install transformer-engine==1.12.0
```
Smoke test:
```python
import torch, transformer_engine as te
from transformer_engine.pytorch import fp8_model_init, Linear
with fp8_model_init(enabled=False):
    pass
y = Linear(512, 512).cuda().to(torch.bfloat16)(torch.randn(4,512,dtype=torch.bfloat16,device='cuda'))
from transformer_engine_torch import DType as TE_DType
```
Failure signature if torch binding .so missing: `StopIteration` in `transformer_engine/pytorch/__init__.py` `_load_library()` — means `transformer_engine_pytorch.so` was never built. Note the top-level `import transformer_engine` succeeds even without the .so (it catches ImportError for the pytorch submodule) — always run the `Linear` forward, not just the import.

## Why you might not need flash-attn

swift.megatron `--attention_backend unfused` (also: fused/te, local/triton, flash) — `unfused` uses pure PyTorch attention and needs no flash-attn build. See ms-swift-megatron-training for which backends are actually usable on qwen3.5.
