# vLLM 0.19 multi-node TP=2 + Qwen3.5 megatron-LoRA (verified 2026-08)

Two-node RTX 3090 (driver 550.142), Qwen3.5-9B-Claude-distill (`qwen3_5`),
megatron-trained LoRA. Everything below verified in-session.

## Version chain (the part that matters)

- `Qwen3_5ForConditionalGeneration` needs vLLM >= 0.17 natively
  (registry hit confirmed).
- vLLM 0.17.1 pins `transformers<5`; the model's `tokenizer_class:
  TokenizersBackend` only exists in transformers 5.x -> startup fails with
  `ValueError: Tokenizer class TokenizersBackend does not exist or is not
  currently imported.`
- vLLM 0.19.1 allows `transformers>=4.56,!=5.0.*..!=5.5.0` -> pair it with
  `transformers==5.12.1` (same as the training venv).
- vLLM 0.19.1 requires `torch==2.10.0`. The +cu128 wheel RUNS on driver
  550.142 (advertises CUDA 12.4): smoke-tested `cuda_available=True`,
  matmul OK. Do not pre-BLOCK a cu128 user-mode wheel on a 12.x driver;
  smoke first.
- ray: 2.48.0 fails on py3.10 with `ValueError: <object ...> is not a valid
  Sentinel` (typing_extensions interplay). Use `ray[cgraph]==2.56.1`.
  `ray start --head` without dashboard deps -> `Cannot include dashboard with
  missing packages` -> add `--include-dashboard false`.
- Install into a dedicated venv with uv; uv-created venvs may lack
  `bin/activate`, so invoke `<venv>/bin/python` by absolute path.

## Single-node smoke (before going multi-node)

```python
from vllm import LLM, SamplingParams
from vllm.lora.request import LoRARequest   # NOT exported from top-level vllm

llm = LLM(model=..., tensor_parallel_size=1, dtype='bfloat16',
          max_model_len=2048, gpu_memory_utilization=0.85,
          enforce_eager=True, trust_remote_code=True,
          enable_lora=True, max_lora_rank=8)
lora_req = LoRARequest(lora_name='finance280', lora_int_id=1,
                       lora_path='/path/hf_lora_280')
out = llm.generate([prompt], SamplingParams(...), lora_request=lora_req)
print(out[0].outputs[0].text)
```

- No `llm.load_lora` in 0.19 — always pass `lora_request=` to generate.
- Wrap driver code in `if __name__ == '__main__':` — EngineCore spawns and
  re-imports the main module; missing guard -> `RuntimeError: An attempt has
  been made to start a new process before the current process has finished its
  bootstrapping phase.`
- Model init ~70-200s (cold); first LoRA request slower than plain.

## Multi-node TP=2 via ray

1. head: `ray start --head --node-ip-address 10.0.22.197 --port 6379
   --num-cpus 8 --include-dashboard false` (private IP so workers find it).
2. worker: `ray start --address 10.0.22.197:6379 --node-ip-address 10.0.22.140`.
3. serve (head node only):
   `python -m vllm.entrypoints.openai.api_server --model <base> \
   --tensor-parallel-size 2 --distributed-executor-backend ray \
   --dtype bfloat16 --max-model-len 2048 --gpu-memory-utilization 0.85 \
   --enforce-eager --trust-remote-code --enable-lora --max-lora-rank 8 \
   --lora-modules finance280=/path/hf_lora_280 --host 0.0.0.0 --port 8000`
4. Both ranks get a RayWorkerWrapper with
   `distributed_init_method=tcp://<head>:<port>`; each worker loads the
   adapter locally — sync `hf_lora_*` to EVERY node before serving.
5. Verify with `ray status`: 2 nodes, `X/2.0 GPU`.

## Failure modes seen

- `ValueError: Free memory on device cuda:0 (...) less than desired GPU
  memory utilization` — a previous EngineCore still holds VRAM; kill it,
  don't just retry.
- `ray status` shows `GPU ... reserved in placement groups` after a failed
  run; next serve fails with `Current node has no GPU available` even though
  GPUs exist. Fix: `ray stop --force` on head AND worker, restart the cluster.
- EngineCore "SIGTERM received ... Shutting down Ray distributed executor"
  right after both ranks init = executor teardown; read the lines BEFORE the
  SIGTERM for the real cause.
- **External kill vs real failure**: EngineCore SIGTERM with NO error lines
  before it, GPU back to 0% / 1 MiB, and your own tmux server gone = an
  EXTERNAL kill (another agent session's cleanup / a watchdog), not a vLLM
  fault — reading "lines before the SIGTERM" finds nothing because there is
  nothing. Check for a concurrent GPUCLOUD session first:
  `ps aux | grep gpucloud` (note start times; a second live session means
  someone else is deploying the same node). Two sessions deploying the same
  service kill each other's vllm/ray/tmux processes in a loop and both fail.
  Stop racing: let ONE session own the deployment, or coordinate. Run serve
  in tmux (or setsid) so a peer cleanup cannot take the process down with it,
  and never `pkill -f vllm|ray` broad patterns on a multi-session node.
- `scp` intermittently fails with `scp: <local>: No such file or directory`
  while the file demonstrably exists (observed with sshpass+scp): fall back
  to `cat <local> | ssh host 'mkdir -p <dir> && cat > <remote>'` — reliable,
  no scp involved.
- NCCL smoke before TP>1: use `scripts/nccl_smoke.py` from this skill
  (rank0/rank1 env-var one-liners, expects allreduce=3.0). Run it with the
  SAME venv python that will serve, so the venv's own libnccl is what gets
  validated against the driver.
