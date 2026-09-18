"""Process-local ModelAdapter registry."""

from __future__ import annotations

import logging
from typing import Dict, Optional, Type

from plugins.inference_adapters.base import ModelAdapter

_log = logging.getLogger(__name__)

_REGISTRY: Dict[str, Type[ModelAdapter]] = {}
_INSTANCES: Dict[str, ModelAdapter] = {}


def register_adapter(adapter_cls: Type[ModelAdapter]) -> Type[ModelAdapter]:
    adapter_id = getattr(adapter_cls, "adapter_id", "") or ""
    if not adapter_id:
        raise ValueError(f"{adapter_cls.__name__} must define adapter_id")
    _REGISTRY[adapter_id] = adapter_cls
    _log.info("registered inference adapter %s -> %s", adapter_id, adapter_cls.__name__)
    return adapter_cls


def get_adapter_class(adapter_id: str) -> Optional[Type[ModelAdapter]]:
    return _REGISTRY.get(str(adapter_id or "").strip())


def create_adapter(adapter_id: str) -> ModelAdapter:
    cls = get_adapter_class(adapter_id)
    if cls is None:
        known = ", ".join(sorted(_REGISTRY)) or "(none)"
        raise KeyError(f"unknown adapter_id={adapter_id!r}; known: {known}")
    return cls()


def list_adapters() -> Dict[str, str]:
    return {k: v.__name__ for k, v in sorted(_REGISTRY.items())}


def clear_registry_for_tests() -> None:
    _REGISTRY.clear()
    _INSTANCES.clear()
