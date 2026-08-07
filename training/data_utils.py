"""Shared data helpers for SponsorLens model training scripts."""

from __future__ import annotations

import hashlib
import json
import subprocess
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


LABELS = ("irrelevant", "no", "conditional", "yes", "review")
LABEL2ID = {label: index for index, label in enumerate(LABELS)}
ID2LABEL = {index: label for label, index in LABEL2ID.items()}
SPLITS = ("train", "validation", "test", "challenge")


def load_jsonl(path: str | Path) -> list[dict[str, Any]]:
    source = Path(path)
    examples: list[dict[str, Any]] = []
    with source.open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            line = raw_line.strip()
            if not line:
                continue
            try:
                example = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(
                    f"{source}:{line_number}: invalid JSON: {error.msg}"
                ) from error
            if not isinstance(example, dict):
                raise ValueError(f"{source}:{line_number}: expected a JSON object")
            example["_line"] = line_number
            examples.append(example)
    return examples


def deterministic_split(group_id: str) -> str:
    """Assign a complete group to a stable 80/10/10 split."""
    digest = hashlib.sha256(group_id.encode("utf-8")).digest()
    bucket = int.from_bytes(digest[:4], "big") % 100
    if bucket < 80:
        return "train"
    if bucket < 90:
        return "validation"
    return "test"


def with_assigned_splits(
    examples: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    assigned: list[dict[str, Any]] = []
    group_splits: dict[str, str] = {}
    for original in examples:
        example = dict(original)
        group_id = str(example.get("group_id", ""))
        split = example.get("split") or deterministic_split(group_id)
        previous = group_splits.setdefault(group_id, split)
        if previous != split:
            raise ValueError(
                f"group_id {group_id!r} appears in both {previous!r} and {split!r}"
            )
        example["split"] = split
        assigned.append(example)
    return assigned


def select_split(
    examples: Iterable[dict[str, Any]], split: str
) -> list[dict[str, Any]]:
    return [example for example in examples if example.get("split") == split]


def label_counts(examples: Iterable[dict[str, Any]]) -> dict[str, int]:
    counts = Counter(str(example.get("label")) for example in examples)
    return {label: counts.get(label, 0) for label in LABELS}


def validate_runtime_gate(path: str | Path) -> None:
    script = Path(__file__).with_name("validate_runtime_gate.js")
    try:
        result = subprocess.run(
            ["node", str(script), str(Path(path).resolve())],
            capture_output=True,
            check=False,
            encoding="utf-8",
        )
    except FileNotFoundError as error:
        raise ValueError("Node.js is required to validate runtime windows") from error
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip()
        raise ValueError(message or "runtime candidate validation failed")
