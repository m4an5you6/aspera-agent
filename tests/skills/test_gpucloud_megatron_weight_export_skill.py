"""Skill metadata tests for gpucloud-megatron-weight-export."""

from __future__ import annotations

import re
from pathlib import Path

SKILL_DIR = Path(__file__).parents[2] / "skills/mlops/gpucloud-megatron-weight-export"
SKILL_PATH = SKILL_DIR / "SKILL.md"
REF_PATH = SKILL_DIR / "references/export-recipes.md"


def test_description_length():
    text = SKILL_PATH.read_text(encoding="utf-8")
    m = re.search(r"^description: (.*)$", text, re.MULTILINE)
    assert m, "description frontmatter missing"
    assert len(m.group(1)) <= 60, len(m.group(1))


def test_is_playbook_not_platform_http_client():
    text = SKILL_PATH.read_text(encoding="utf-8")
    assert "ModelOpt" in text
    assert "SWIFT" in text
    assert "last resort" in text.lower()
    assert "load_distcp" in text
    # Must not teach curling platform internal inference HTTP.
    assert "/export-megatron" not in text
    assert "/api/internal/inference" not in text
    assert "18000" not in text
    assert "not a platform HTTP" in text.lower() or "not a platform http" in text.lower()


def test_reference_has_executable_recipes():
    text = REF_PATH.read_text(encoding="utf-8")
    assert "export.py" in text
    assert "--mcore_adapter" in text
    assert "--to_hf" in text
    assert "/export-megatron" not in text
