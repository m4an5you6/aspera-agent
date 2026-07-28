# Multi-node NCCL and libnccl Drift

Lessons from multi-node vLLM TP (one GPU per node, Ethernet, no IB).
Ordinary TCP can be fine while GPU collectives still fail.

## Do not confuse layers

| Layer | What it proves | Typical check |
|-------|----------------|---------------|
| Host TCP | Machines can reach each other | `ping`, SSH, open ports |
| Ray control plane | Workers joined the head | `ray status` shows 2+ nodes |
| Gloo / CPU store | Process-group over TCP | `dist.init_process_group("gloo")` + allreduce |
| NCCL | GPU collective path | `dist.init_process_group("nccl")` + CUDA allreduce |

If Gloo passes and NCCL fails, **do not** spend turns on “nodes cannot communicate.”
Fix the NCCL/CUDA stack alignment instead.

## Observed failure (Deploy-38 class)

- Drivers identical: `550.142` (CUDA 12.4 capability).
- `torch==2.5.1+cu124` imported and `torch.cuda.is_available()` true on both nodes.
- Cross-node **Gloo** allreduce: OK.
- Cross-node **NCCL** allreduce: fail on the worker with:

```text
Cuda failure 'CUDA driver version is insufficient for CUDA runtime version'
NCCL error: unhandled cuda error
```

Root cause: **mismatched `libnccl.so.2` binaries** under the inference venv.

| Node | `strings …/nvidia/nccl/lib/libnccl.so.2 \| grep 'NCCL version'` |
|------|------------------------------------------------------------------|
| Healthy head | `NCCL version 2.21.5+cuda12.4` |
| Broken worker | `NCCL version 2.28.9+cuda13.0` |

`pip show nvidia-nccl-cu12` can still print `2.21.5` on both while the `.so`
on disk differs (metadata drift after a prior cu130 / newer-vLLM install).
`torch.cuda.nccl.version()` may also report the torch **build** NCCL, not the
loaded file — always inspect the `.so` with `strings`.

vLLM then dies in `ncclCommInitRank` on the remote Ray worker with the same
`unhandled cuda error`. Ray head/join and SSH look healthy the whole time.

## Mandatory checks before multi-node `inference_start_vllm`

On **every** rank, in the **same** `inference_venvs/<tag>` python:

```bash
PY="$HOME/.cache/gpu_platform/inference_venvs/<tag>/bin/python"
NCCL_SO="$HOME/.cache/gpu_platform/inference_venvs/<tag>/lib/python3.10/site-packages/nvidia/nccl/lib/libnccl.so.2"
nvidia-smi --query-gpu=driver_version --format=csv,noheader
"$PY" -c "import torch; print(torch.__version__, torch.version.cuda)"
strings "$NCCL_SO" | grep -F 'NCCL version' | head -3
ls -l "$NCCL_SO"
```

All ranks must share the same torch pin **and** the same NCCL version string
(e.g. both `2.21.5+cuda12.4` when the driver is 12.4). File size of
`libnccl.so.2` should match across nodes.

## NCCL smoke (before vLLM)

With Ray already optional — for a pure stack check, run a 2-process torch
distributed job (rank0 on head IP, rank1 on worker). Prefer a short timeout.

1. Prove Gloo once (isolates TCP).
2. Prove NCCL with explicit process env (not only shell profile):

```bash
# process-local only — example
export MASTER_ADDR=<head_ip> MASTER_PORT=29500 WORLD_SIZE=2
export NCCL_DEBUG=INFO NCCL_IB_DISABLE=1 NCCL_P2P_DISABLE=1
export NCCL_SOCKET_IFNAME=<data_iface>   # e.g. enp3s0
export NCCL_NET=Socket GLOO_SOCKET_IFNAME=<data_iface>
```

NCCL must print `ALLREDUCE_OK` on both ranks before starting vLLM TP>1.

If NCCL fails with “driver insufficient” / cuda13 NCCL on a 12.4 driver:
reinstall the cu12 NCCL wheel that matches the torch pin into that venv
(exact `nvidia-nccl-cu12==…`), re-check `strings`, rerun smoke. Do **not**
keep restarting vLLM.

## Ray / vLLM env pitfalls

- Injecting `NCCL_*` only on the API-server process is not enough; remote Ray
  actors may not inherit them. Put vars into the environment of `ray start` /
  `ray join` workers (and verify with `printenv` inside a Ray worker task).
- vLLM 0.7.x Ray executor historically whitelists few env prefixes; treat
  “NCCL_DEBUG only on local rank” as evidence remote actors lack the vars.
- `trust_remote_code` must appear on the real vLLM CLI (`--trust-remote-code`);
  putting it only in unstructured `adapter_options` may be ignored.

## Fallback

If NCCL smoke fails after aligning `libnccl` (or IB is unavailable and Socket
NCCL remains broken), **stop burning turns on TP=N across nodes**. Prefer:

1. Single-node serve with TP equal to local GPUs, or
2. Report `phase=start` with a clear NCCL/`libnccl` diagnostic

Do not claim “nodes cannot communicate” when Gloo/Ray already succeed.
