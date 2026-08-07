"""Integrity helpers for packaged SponsorLens ONNX artifacts."""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any, Iterable


REQUIRED_PACKAGE_FILES = (
    "config.json",
    "tokenizer.json",
)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_file_manifest(
    directory: Path, relative_paths: Iterable[str]
) -> dict[str, str]:
    return {
        relative_path: file_sha256(directory / relative_path)
        for relative_path in sorted(set(relative_paths))
    }


def deployment_sha256(
    version: str,
    labels: list[str],
    max_length: int,
    files: dict[str, str],
) -> str:
    payload = {
        "version": version,
        "labels": labels,
        "max_length": max_length,
        "files": files,
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def validate_thresholds(
    thresholds: Any, labels: Iterable[str]
) -> dict[str, float | None]:
    if not isinstance(thresholds, dict):
        raise ValueError("threshold payload must be an object")
    expected = list(labels)
    missing = sorted(set(expected) - set(thresholds))
    extra = sorted(set(thresholds) - set(expected))
    if missing:
        raise ValueError("threshold file is missing labels: " + ", ".join(missing))
    if extra:
        raise ValueError("threshold file has unknown labels: " + ", ".join(extra))

    validated: dict[str, float | None] = {}
    for label in expected:
        value = thresholds[label]
        if value is None:
            validated[label] = None
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"threshold for {label!r} must be a number or null")
        numeric = float(value)
        if not math.isfinite(numeric) or not 0.0 <= numeric <= 1.0:
            raise ValueError(f"threshold for {label!r} must be between 0 and 1")
        validated[label] = numeric
    return validated


def validate_artifact_directory(
    directory: Path,
    onnx_path: Path | None = None,
) -> dict[str, Any]:
    artifact_path = directory / "artifact.json"
    if not artifact_path.exists():
        raise ValueError(f"missing artifact manifest: {artifact_path}")
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))

    version = artifact.get("version")
    labels = artifact.get("labels")
    max_length = artifact.get("max_length")
    files = artifact.get("files")
    if not isinstance(version, str) or not version:
        raise ValueError("artifact version is missing")
    if not isinstance(labels, list) or not labels or not all(
        isinstance(label, str) for label in labels
    ):
        raise ValueError("artifact labels are invalid")
    if not isinstance(max_length, int) or max_length < 1:
        raise ValueError("artifact max_length is invalid")
    if not isinstance(files, dict) or not files:
        raise ValueError("artifact file manifest is missing")

    for required in REQUIRED_PACKAGE_FILES:
        if required not in files:
            raise ValueError(f"artifact file manifest is missing {required}")
    onnx_entries = [name for name in files if name.endswith(".onnx")]
    if len(onnx_entries) != 1:
        raise ValueError("artifact must contain exactly one ONNX graph")

    for relative_path, expected_hash in files.items():
        path = Path(relative_path)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError(f"unsafe artifact path: {relative_path}")
        absolute = directory / path
        if not absolute.is_file():
            raise ValueError(f"artifact file is missing: {relative_path}")
        if file_sha256(absolute) != expected_hash:
            raise ValueError(f"artifact checksum mismatch: {relative_path}")

    expected_deployment_hash = deployment_sha256(
        version,
        labels,
        max_length,
        files,
    )
    if artifact.get("deployment_sha256") != expected_deployment_hash:
        raise ValueError("artifact deployment checksum is invalid")

    config = json.loads((directory / "config.json").read_text(encoding="utf-8"))
    label2id = config.get("label2id")
    id2label = config.get("id2label")
    expected_label2id = {label: index for index, label in enumerate(labels)}
    expected_id2label = {index: label for index, label in enumerate(labels)}
    normalized_label2id = {
        str(label): int(index) for label, index in (label2id or {}).items()
    }
    normalized_id2label = {
        int(index): str(label) for index, label in (id2label or {}).items()
    }
    if (
        normalized_label2id != expected_label2id or
        normalized_id2label != expected_id2label
    ):
        raise ValueError("config label order does not match artifact labels")

    if onnx_path is not None:
        expected_onnx = (directory / onnx_entries[0]).resolve()
        if onnx_path.resolve() != expected_onnx:
            raise ValueError("--onnx does not point to the artifact's tracked graph")
    return artifact
