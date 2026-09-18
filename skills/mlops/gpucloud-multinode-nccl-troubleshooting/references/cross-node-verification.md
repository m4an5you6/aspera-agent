# Cross-node Package Consistency Verification

After multi-node deployments where `pip install` is run on any node,
packages frequently drift due to transitive dependency resolution. This
checklist catches mismatches before they cause cryptic errors (NCCL failures,
`ParallelConfig.world_size_across_dp`, Ray `copy.deepcopy` Sentinel errors).

## Verification Checklist

Run on **every node** before `inference_start_vllm`:

```bash
PY="$HOME/.cache/gpu_platform/inference_venvs/cu124/bin/python"

echo "=== torch ==="
$PY -c "import torch; print(torch.__version__, 'cuda:', torch.version.cuda)"

echo "=== vllm ==="
$PY -c "import vllm; print(vllm.__version__)"

echo "=== ray ==="
$PY -c "import ray; print(ray.__version__)"

echo "=== click ==="
$PY -c "import click; print(click.__version__)"

echo "=== transformers ==="
$PY -c "import transformers; print(transformers.__version__)"

echo "=== NCCL binary ==="
strings $HOME/.cache/gpu_platform/inference_venvs/cu124/lib/python3.10/site-packages/nvidia/nccl/lib/libnccl.so.2 | grep -F 'NCCL version' | head -1

echo "=== NCCL file size ==="
ls -l $HOME/.cache/gpu_platform/inference_venvs/cu124/lib/python3.10/site-packages/nvidia/nccl/lib/libnccl.so.2 | awk '{print $5, $NF}'

echo "=== CUDA smoke ==="
$PY -c "import torch; t=torch.randn(3,3,device='cuda'); print('CUDA_OK', t.sum().item())"

echo "=== nvidia-smi ==="
nvidia-smi --query-gpu=driver_version,name,memory.total --format=csv,noheader
```

## Known Good Pinning (CUDA 12.4 / Driver 550.142)

| Package | Version | Notes |
|---------|---------|-------|
| torch | 2.5.1+cu124 | Install first with `--extra-index-url https://download.pytorch.org/whl/cu124` |
| vllm | 0.7.3 | Requires `ray[adag]==2.40.0`. Install with `--no-deps` after torch |
| ray | 2.40.0 | Install with `--no-deps` to prevent vllm upgrade |
| click | 8.1.7 | **Must pin exactly**. 8.4.2 breaks Ray CLI on Python 3.10 |
| transformers | 4.54.0 | Latest compatible with vLLM 0.7.3; has `_experts_implementation_internal` |

## Drift Fix Sequence

When a node is out of alignment, fix in this order (Tsinghua mirror):
```bash
PIP="$HOME/.cache/gpu_platform/inference_venvs/cu124/bin/pip"
MIRROR="-i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn"

# 1. torch first (with CUDA wheel index)
$PIP install "torch==2.5.1+cu124" "torchvision==0.20.1+cu124" "torchaudio==2.5.1+cu124" \
  --extra-index-url https://download.pytorch.org/whl/cu124 $MIRROR

# 2. click pinned (before Ray, which would upgrade it)
$PIP install "click==8.1.7" --no-deps $MIRROR

# 3. transformers (before vllm)
$PIP install "transformers==4.54.0" $MIRROR

# 4. vllm (no-deps prevents torch upgrade)
$PIP install "vllm==0.7.3" --force-reinstall --no-deps $MIRROR

# 5. ray (no-deps prevents vllm/torch upgrade)
$PIP install "ray==2.40.0" --force-reinstall --no-deps $MIRROR

# 6. Re-pin click (ray may have upgraded it)
$PIP install "click==8.1.7" --no-deps $MIRROR

# 7. Verify
$PY -c "import torch,vllm,ray,click,transformers; \
  print('torch',torch.__version__); print('vllm',vllm.__version__); \
  print('ray',ray.__version__); print('click',click.__version__); \
  print('transformers',transformers.__version__)"
```

## HF Custom Module Cache

Models with `auto_map` in `config.json` (e.g., Qwen3.5 MoE) cache custom
Python files in:
```
~/.cache/huggingface/modules/transformers_modules/<model_name>/<hash>/
```

Workers may have incomplete caches (missing `configuration_*.py`). Symptoms:
- `ModuleNotFoundError: No module named 'configuration_qwen3_5_moe'` on Ray worker
- Model loads on head but fails on worker during `RayWorkerWrapper.__init__`

Fix — copy the missing file from the model directory into the HF cache:
```bash
# On the affected worker node
MODEL_DIR="/path/to/model/snapshots/master"
CACHE_DIR="$HOME/.cache/huggingface/modules/transformers_modules/master/<hash>/"
cp "$MODEL_DIR/configuration_qwen3_5_moe.py" "$CACHE_DIR/"
```
