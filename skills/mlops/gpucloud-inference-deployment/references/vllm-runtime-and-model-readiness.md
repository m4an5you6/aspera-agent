# vLLM Runtime and Model Readiness

## Runtime Compatibility

vLLM can upgrade torch if dependencies are not pinned. Check the node driver,
installed CUDA runtime, torch version, and vLLM version together. If the worker
already has a known-good torch build for training, avoid unpinned vLLM installs
that replace it.

## Where to probe and install

Inference deps live in a dedicated venv, not system Python:

1. `$INFERENCE_PYTHON` / `$VLLM_PYTHON` when set
2. Else `~/.cache/gpu_platform/inference_venvs/<tag>/bin/python`
   (create the venv if missing; common tag: `cu124`)

Probe and install only with that interpreter / its `bin/pip`. Pass the same
path as `python_executable` when starting vLLM. A failed
`python3 -c "import vllm"` on the system interpreter does not mean the node
has no vLLM.

```bash
PY="${INFERENCE_PYTHON:-$HOME/.cache/gpu_platform/inference_venvs/cu124/bin/python}"
"$PY" -c "import torch,vllm; print(torch.__version__, vllm.__version__, torch.cuda.is_available())"
nvidia-smi
```

For CUDA 12.x images, a pinned vLLM/torch/xformers/triton/transformers set is
usually safer than latest packages.

## HF/vLLM Directory Markers

Common minimum files:

```text
config.json
pytorch_model.bin or model.safetensors
tokenizer.json or tokenizer.model or vocab.json/merges.txt
tokenizer_config.json
```

Validate `config.json` before launch. It should contain `model_type` and
architecture fields compatible with vLLM. A directory with only Megatron
checkpoint shards is not vLLM loadable.

## Conversion Safety

Megatron checkpoint conversion depends on Megatron version, model architecture,
tensor/pipeline parallel settings, tokenizer files, and target HF format. If
GPUCLOUD cannot prove a converter is compatible, fail with a diagnostic and ask
for `conversion.command_template` or a preconverted `inference.model_path`.

For GPT-2 style conversion, verify HF Conv1D weight layout. Incorrect
transposition can produce shape assertions during vLLM model load.

## Health Check

After local vLLM starts, poll a local health endpoint before reporting success.
If health fails, return:

- pid status
- exit code if present
- log tail
- resolved model path
- host and port
- package versions when available
- which `python_executable` was used
