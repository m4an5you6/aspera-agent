# NCCL Smoke Test Script

Proven script for verifying cross-node NCCL/Gloo allreduce before starting
multi-node vLLM. Tested on torch 2.5.1+cu124, RTX 3090, CUDA 12.4 driver.

## Script: `/tmp/nccl_smoke.py`

```python
"""NCCL smoke test for multi-node TP."""
import os
import sys
import torch
import torch.distributed as dist

def main():
    rank = int(os.environ["RANK"])
    world_size = int(os.environ["WORLD_SIZE"])
    master_addr = os.environ["MASTER_ADDR"]
    master_port = os.environ["MASTER_PORT"]

    print(f"[Rank {rank}] Initializing process group...", flush=True)
    
    # Test Gloo first
    dist.init_process_group(
        backend="gloo",
        rank=rank,
        world_size=world_size,
        init_method=f"tcp://{master_addr}:{master_port}",
    )
    tensor = torch.tensor([float(rank + 1)])
    dist.all_reduce(tensor, op=dist.ReduceOp.SUM)
    expected = sum(range(1, world_size + 1))
    assert tensor.item() == expected, f"Gloo: expected {expected}, got {tensor.item()}"
    print(f"[Rank {rank}] GLOO_ALLREDUCE_OK sum={tensor.item()}", flush=True)
    dist.destroy_process_group()

    # Test NCCL
    dist.init_process_group(
        backend="nccl",
        rank=rank,
        world_size=world_size,
        init_method=f"tcp://{master_addr}:{master_port}",
    )
    device = torch.device(f"cuda:{rank % torch.cuda.device_count()}")
    tensor = torch.tensor([float(rank + 1)], device=device)
    dist.all_reduce(tensor, op=dist.ReduceOp.SUM)
    expected = sum(range(1, world_size + 1))
    assert tensor.item() == expected, f"NCCL: expected {expected}, got {tensor.item()}"
    print(f"[Rank {rank}] NCCL_ALLREDUCE_OK sum={tensor.item()}", flush=True)
    dist.destroy_process_group()
    print(f"[Rank {rank}] ALL_OK", flush=True)

if __name__ == "__main__":
    main()
```

## Running the smoke test

### Rank 0 (head node)
```bash
PY="/home/ubuntu/.cache/gpu_platform/inference_venvs/cu124/bin/python"
export MASTER_ADDR=10.0.21.105 MASTER_PORT=29501 WORLD_SIZE=2 RANK=0
export NCCL_DEBUG=WARN NCCL_IB_DISABLE=1 NCCL_P2P_DISABLE=1
export NCCL_SOCKET_IFNAME=enp3s0 NCCL_NET=Socket GLOO_SOCKET_IFNAME=enp3s0
$PY /tmp/nccl_smoke.py
```

### Rank 1 (worker node)
```bash
ssh worker-node '
export MASTER_ADDR=10.0.21.105 MASTER_PORT=29501 WORLD_SIZE=2 RANK=1
export NCCL_DEBUG=WARN NCCL_IB_DISABLE=1 NCCL_P2P_DISABLE=1
export NCCL_SOCKET_IFNAME=enp3s0 NCCL_NET=Socket GLOO_SOCKET_IFNAME=enp3s0
/home/ubuntu/.cache/gpu_platform/inference_venvs/cu124/bin/python /tmp/nccl_smoke.py
'
```

### Expected output
Both ranks must print:
```
[Rank 0] GLOO_ALLREDUCE_OK sum=3.0
[Rank 0] NCCL_ALLREDUCE_OK sum=3.0
[Rank 0] ALL_OK
[Rank 1] GLOO_ALLREDUCE_OK sum=3.0
[Rank 1] NCCL_ALLREDUCE_OK sum=3.0
[Rank 1] ALL_OK
```

## Pitfalls

- `torch.distributed.Timedelta` does not exist in torch 2.5.x — use
  `from datetime import timedelta` and `timeout=timedelta(seconds=N)`.
- Always use `flush=True` in `print()` calls so output appears before the
  process hangs or crashes.
- The NCCL env vars (`NCCL_SOCKET_IFNAME`, etc.) must be set in the
  **process environment**, not just the shell. They are propagated to the
  torch.distributed backend at init time.
- `MASTER_ADDR` must be the head node's **inner IP** (e.g., 10.0.21.105),
  not the public/outer IP.
