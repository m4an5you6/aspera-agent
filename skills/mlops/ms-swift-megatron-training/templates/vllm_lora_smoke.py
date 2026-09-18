#!/usr/bin/env python3
"""vLLM offline smoke test for a trained LoRA (vLLM >= 0.17 / 0.19.x API).

Validates that a ms-swift-exported hf_lora_<step> adapter loads and changes
generation vs the base model. Run in the inference venv (e.g. vllmvenv):

    <venv>/bin/python vllm_lora_smoke.py > smoke.log 2>&1

Pitfalls encoded here (vLLM 0.19.1):
- `llm.load_lora()` no longer exists (AttributeError) -> use LoRARequest + generate().
- `LoRARequest` is NOT exported from the vllm top level -> import from vllm.lora.request.
- If the model family is a VLM hybrid (Qwen3.5), expect harmless
  "no matching PunicaWrapper is found; visual.blocks.N ... will be ignored" warnings.
"""
import time

from vllm import LLM, SamplingParams
from vllm.lora.request import LoRARequest  # NOT `from vllm import LoRARequest` in 0.19.x


def main() -> None:
    BASE_MODEL = "/path/to/base/model-dir"
    LORA_PATH = "/path/to/output/hf_lora_280"  # ms-swift exported adapter dir
    PROMPT = "Explain what is a derivative in finance in one sentence."

    t0 = time.time()
    llm = LLM(
        model=BASE_MODEL,
        tensor_parallel_size=1,
        dtype="bfloat16",
        max_model_len=2048,
        gpu_memory_utilization=0.85,
        enforce_eager=True,  # skip CUDA-graph capture; avoids LoRA graph-capture bugs
        trust_remote_code=True,  # custom Qwen configs
        enable_lora=True,
        max_lora_rank=8,  # must be >= the training lora_rank
    )
    print(f"LLM init done in {time.time() - t0:.1f}s", flush=True)

    lora_req = LoRARequest(
        lora_name="trained_lora",
        lora_int_id=1,
        lora_path=LORA_PATH,
    )
    params = SamplingParams(temperature=0.7, top_p=0.9, max_tokens=128)

    t2 = time.time()
    out = llm.generate([PROMPT], params, lora_request=lora_req)
    print(f"=== WITH LoRA ({(time.time() - t2) * 1000:.0f}ms) ===", flush=True)
    print(out[0].outputs[0].text, flush=True)

    t3 = time.time()
    out2 = llm.generate([PROMPT], params)
    print(f"=== WITHOUT LoRA ({(time.time() - t3) * 1000:.0f}ms) ===", flush=True)
    print(out2[0].outputs[0].text, flush=True)

    print("SMOKE_TEST_DONE", flush=True)


if __name__ == "__main__":
    main()
