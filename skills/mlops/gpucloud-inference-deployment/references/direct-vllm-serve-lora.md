# Direct vLLM serve with LoRA (user's own nodes, no platform tools)

Verified 2026-08 on the user's RTX 3090 nodes (driver 550 / CUDA 12.4 cap,
torch 2.6.0+cu124, vLLM 0.19.1 in `~/vllmvenv`). Serving a swift/megatron LoRA
export (`hf_lora_280`) on top of Qwen3.5-9B-Claude-distill.

## User preference (important)

For inference access the user expects a STANDING vLLM service + curl POST, not
one-shot SSH-executed python scripts ("一般开启服务的话只用curl,post的命令不就可以了吗").
Deploy the serve, then hand over curl commands. One-shot scripts
(`infer_once.py`: `LLM` + `generate` + `LoRARequest`, print, exit) are the
fallback when a service is unwanted — each call re-loads the model (~76s).

## Serve command (tmux-wrapped so SSH drops never kill it)

```bash
tmux new-session -d -s vllm 'cd /home/ubuntu && /home/ubuntu/vllmvenv/bin/python -m vllm.entrypoints.openai.api_server \
  --model /home/ubuntu/models/Qwen3.5-9B-Claude-distill \
  --trust-remote-code --dtype bfloat16 --max-model-len 2048 \
  --gpu-memory-utilization 0.85 --enforce-eager \
  --enable-lora --max-lora-rank 8 \
  --lora-modules finance280=/home/ubuntu/output/qwen35_finance_tp2/hf_lora_280 \
  --host 0.0.0.0 --port 8000 > /home/ubuntu/vllm_serve.log 2>&1'
```

- `hf_lora_*` dirs from the swift megatron export (adapter_config.json +
  adapter_model.safetensors) load directly as `--lora-modules name=/abs/path`.
  The request `"model"` field must be that NAME (e.g. `finance280`) to activate
  the adapter; using the base model name / omitting it serves without LoRA.
- `--enforce-eager` skips CUDA-graph capture (avoids LoRA+cudagraph issues on
  hybrid archs, see SKILL.md pitfalls).
- 24GB card: 0.85 utilization peaks ~21GB incl. KV cache; leftover KV cache is
  small (~0.45GiB → ~4 concurrent 2k-token requests).

## Readiness + verification

- Poll `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/health`
  until 200 (~90s incl. model load); log line `Application startup complete.`
  confirms the API server is up.
- POST test:
```bash
curl -s http://127.0.0.1:8000/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model": "finance280", "messages": [{"role": "user", "content": "..."}], "max_tokens": 128}'
```
- Measured: 128 tokens ≈ 16s on TP=1 (model load 60-90s once at startup).
- Stop/restart: `tmux kill-session -t vllm`, re-run the tmux line. Watch the
  log, not the tmux pane.

## Public access — VERIFY the real public IP first (don't trust memory)

The node's public IP is a NAT-gateway address that CHANGES. Verified 2026-08:
this node = 36.103.199.245, peer = 36.103.199.200 (stale memory said
36.103.199.132 — that IP pointed nowhere and produced a wrong "port closed"
conclusion that frustrated the user, whose ports were already open). The user
has opened all ports on the gateway: `curl http://<this-node-public-ip>:8000/health`
FROM THE PEER NODE returned HTTP 200, and a full chat-completions POST over the
public IP worked (TP=2 service). No port-forward rule was needed.

Before claiming a port is blocked / needs NAT forwarding:
1. Confirm the machine's ACTUAL public IP (ask the user; never rely on memory).
2. Test from the PEER node — peer→public round-trip is the ground truth for
   internet reachability:
   `ssh <peer> 'curl -s -m 8 -o /dev/null -w "%{http_code}" http://<public-ip>:8000/health'`
3. Only if that fails, discuss NAT port-forward rules or an SSH tunnel.

Public curl once verified open (no tunnel needed):
```bash
curl http://<public-ip>:8000/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model": "finance280", "messages": [{"role": "user", "content": "..."}], "max_tokens": 256}'
```

SSH tunnel remains a fallback only when the port genuinely isn't open:
`ssh -N -L 8000:127.0.0.1:8000 ubuntu@<public-ip>` then curl
`http://127.0.0.1:8000/...` locally.

## Pitfalls specific to this recipe

- Two concurrent serve/smoke processes both requesting
  `gpu_memory_utilization=0.85`: the second fails with
  `ValueError: Free memory on device cuda:0 (...) less than desired GPU memory
  utilization`. Check `nvidia-smi --query-compute-apps=...` before launching.
- vLLM 0.19.1: `llm.load_lora()` is gone and `from vllm import LoRARequest`
  raises ImportError — import from `vllm.lora.request` (full details in
  SKILL.md pitfalls).
- vLLM deprecation warning about tokenizer-per-LoRA is benign — base tokenizer
  is used by default.
