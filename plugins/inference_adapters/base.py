"""ModelAdapter interface — fixed lifecycle for inference assignments."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Literal, Optional


HealthState = Literal["ready", "degraded", "dead"]


@dataclass
class EndpointInfo:
    host: str
    port: int
    protocol: str = "http://"
    stream_path: str = "/v1/chat/completions"
    health_path: str = "/health"
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @property
    def visit_url(self) -> str:
        return f"{self.protocol}{self.host}:{self.port}"


@dataclass
class ArtifactPaths:
    model_path: str
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class ModelAdapter(ABC):
    """Per-model inference strategy. Runtime owns outcome reporting."""

    adapter_id: str = ""

    @abstractmethod
    def validate(self, spec: Dict[str, Any]) -> List[str]:
        """Return validation errors (empty = ok). Must not start processes."""

    def ensure_runtime(self, spec: Dict[str, Any]) -> None:
        """Install/verify runtime per spec['runtime'].scheme tasks. Default: no-op."""
        return None

    @abstractmethod
    def ensure_artifacts(self, spec: Dict[str, Any]) -> ArtifactPaths:
        """Prepare local loadable artifacts (pull/convert as needed)."""

    @abstractmethod
    def start(self, spec: Dict[str, Any], artifacts: ArtifactPaths) -> EndpointInfo:
        """Start the inference process and return visit endpoint info."""

    @abstractmethod
    def health(self) -> HealthState:
        """Probe the running service."""

    @abstractmethod
    def stop(self) -> None:
        """Stop processes started by this adapter instance."""
