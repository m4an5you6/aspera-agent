"""Inference adapters plugin — ModelAdapter registry + hf_vllm reference."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def register(ctx) -> None:
    """Enable via plugins.enabled: [inference_adapters]."""
    # Import side-effect: register built-in adapters
    from plugins.inference_adapters import hf_vllm as _hf_vllm  # noqa: F401
    from plugins.inference_adapters.registry import list_adapters

    def _list_adapters(args: dict, **kwargs: Any) -> str:
        import json

        return json.dumps({"success": True, "adapters": list_adapters()})

    ctx.register_tool(
        name="inference_adapter_list",
        toolset="inference_adapters",
        schema={
            "name": "inference_adapter_list",
            "description": "List registered inference ModelAdapter ids on this worker.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
        handler=_list_adapters,
        emoji="🧩",
    )
    logger.info(
        "inference_adapters plugin registered (%s)",
        ", ".join(list_adapters()) or "no adapters",
    )
