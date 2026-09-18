# gemma4_unified inference: vLLM 0.19.1 limits + working transformers-4bit single-GPU serve

Verified 2026-08-06 on the user's RTX 3090 nodes (driver 550.142, swiftvenv
torch 2.6.0+cu124, vllmvenv vLLM 0.19.1 + torch 2.10.0+cu128 + ray 2.56.1),
serving gemma-4-12B (model_type `gemma4_unified`) + finance LoRA (hf_lora_650).

## vLLM 0.19.1 measured limits for gemma4_unified (do not burn time re-testing)

- **TP=1 loads the weights fine** (engine got to 22.3 GiB allocated) but the
  bf16 model is 23.9 GB > 24 GB card → `torch.OutOfMemoryError`. This is
  MEMORY, not architecture — the model is NOT rejected at registry lookup
  (earlier notes saying "cannot be served by vLLM 0.19.1" were wrong).
- **TP=2 (multi-node ray)**: `RuntimeError: shape '[1, 2048, -1, 512]' is
  invalid for input of size 524288` from the Ray worker (both nodes). The
  `2048` is model-internal (NOT `--max-model-len`; retrying with 512 failed
  identically) — a TP-sharding reshape bug in the 0.19.1 gemma4_unified
  implementation. No CLI flag works around it.
- **TP=2 + `--enable-lora`**: `AssertionError` at
  `vllm/lora/ops/triton_ops/lora_shrink_op.py:182`
  (`assert token_lora_mapping.size(0) == M`) during engine init (LoRA weight
  load). Also unfixable by flags.
- Bottom line: **no vLLM 0.19.1 path serves gemma4_unified at TP=2**, and TP=1
  needs quantization. Do not try to "upgrade vLLM" either — the Tsinghua PyPI
  mirror still serves 0.19.1 as latest (uv resolves no newer package).

## Working plan: transformers 5.12.1 + bitsandbytes 4-bit + PEFT, single GPU

8 GB VRAM, ~50 s load, ~5.4 tok/s (128 tok ≈ 24 s) — fine for verification and
light serving. The TP=2 requirement was a means to fit 24 GB; 4-bit removes it.

1. Install (into the TRAINING venv — its transformers 5.12.1 natively supports
   gemma4_unified + PEFT; vllmvenv's transformers is also 5.12.1):
   `uv pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
     --python <venv>/bin/python bitsandbytes`   # 0.50.0 verified
2. Load base 4-bit + LoRA:
   ```python
   from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
   from peft import PeftModel
   cfg = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.bfloat16,
                            bnb_4bit_quant_type='nf4', bnb_4bit_use_double_quant=True)
   base = AutoModelForCausalLM.from_pretrained(MODEL, quantization_config=cfg,
                                               device_map='cuda:0', torch_dtype=torch.bfloat16)
   model = PeftModel.from_pretrained(base, HF_LORA_DIR)
   ```
3. The model dir has NO `chat_template` → build prompts manually:
   `<start_of_turn>user\n{msg}<end_of_turn>\n<start_of_turn>model\n`
4. Serve OpenAI-compatible (`/v1/chat/completions` + `/health`) with FastAPI +
   uvicorn in tmux — template: `templates/serve_gemma4_lora.py`.
5. Public reachability: the node's NAT public IP is open (user opened all
   ports); verify from the PEER node (`curl http://<public-ip>:8000/health`),
   then hand over curl POSTs.

## Multi-node ray cluster pitfall (tmux "disappearing" ray)

- `tmux new-session -d -s ray0 'ray start --head ...'` LOOKS like ray died:
  `ray start` returns after daemonizing, the session's bash exits, and when
  that was the only tmux session the tmux server itself exits → `tmux ls`
  says "no server running". The ray daemons (gcs_server/raylet) are actually
  independent and keep running.
- Correct pattern: run `ray start --head --port 6379 --disable-usage-stats`
  in the FOREGROUND (it daemonizes and returns), and on workers
  `ray start --address=<head-ip>:6379 --disable-usage-stats` over ssh (also
  foreground; daemons survive the ssh disconnect). No tmux needed for ray.
- Only the vLLM API server (or the transformers serve) needs tmux/setsid.
- Verify cluster: `ray status` shows 2 nodes before `vllm serve
  --tensor-parallel-size 2 --distributed-executor-backend ray`.
