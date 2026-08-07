#!/usr/bin/env python3
"""Evaluate, calibrate, and select abstention thresholds for a classifier."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import numpy as np
import torch
from sklearn.metrics import (
    classification_report,
    confusion_matrix,
    precision_recall_fscore_support,
)
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from artifact_utils import (
    build_file_manifest,
    deployment_sha256,
    validate_artifact_directory,
    validate_thresholds,
)
from data_utils import (
    LABEL2ID,
    LABELS,
    load_jsonl,
    select_split,
    validate_runtime_gate,
)
from validate_data import validate_dataset


def softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - np.max(logits, axis=1, keepdims=True)
    exponentials = np.exp(shifted)
    return exponentials / np.sum(exponentials, axis=1, keepdims=True)


def expected_calibration_error(
    probabilities: np.ndarray, truth: np.ndarray, bins: int = 10
) -> float:
    confidence = np.max(probabilities, axis=1)
    predicted = np.argmax(probabilities, axis=1)
    correct = predicted == truth
    error = 0.0
    for lower in np.linspace(0.0, 1.0, bins, endpoint=False):
        upper = lower + 1.0 / bins
        mask = (confidence > lower) & (confidence <= upper)
        if not np.any(mask):
            continue
        error += float(np.mean(mask)) * abs(
            float(np.mean(correct[mask])) - float(np.mean(confidence[mask]))
        )
    return error


def brier_score(probabilities: np.ndarray, truth: np.ndarray) -> float:
    expected = np.zeros_like(probabilities)
    expected[np.arange(len(truth)), truth] = 1.0
    return float(np.mean(np.sum((probabilities - expected) ** 2, axis=1)))


def select_thresholds(
    probabilities: np.ndarray,
    truth: np.ndarray,
    target_precision: float,
    minimum_predictions: int,
) -> dict[str, float | None]:
    predicted = np.argmax(probabilities, axis=1)
    thresholds: dict[str, float | None] = {}
    for label, label_id in LABEL2ID.items():
        indices = np.flatnonzero(predicted == label_id)
        scores = probabilities[indices, label_id]
        selected_threshold: float | None = None
        # Evaluate the exact >= threshold set. Iterating an ordered prefix can
        # overstate deployment precision when multiple examples share the
        # boundary score, because the runtime must accept every tied example.
        for threshold in np.unique(scores)[::-1]:
            accepted = indices[scores >= threshold]
            if len(accepted) < minimum_predictions:
                continue
            precision = float(np.mean(truth[accepted] == label_id))
            if precision >= target_precision:
                selected_threshold = float(threshold)
        # Preserve the selected score exactly. Rounding downward can admit a
        # lower-scoring tied/near-tied error at runtime and silently violate
        # the calibrated precision target.
        thresholds[label] = selected_threshold
    return thresholds


def accepted_metrics(
    probabilities: np.ndarray,
    truth: np.ndarray,
    thresholds: dict[str, float | None],
) -> dict[str, Any]:
    predicted = np.argmax(probabilities, axis=1)
    confidence = np.max(probabilities, axis=1)
    accepted_values = []
    for index, label_id in enumerate(predicted):
        threshold = thresholds.get(LABELS[label_id])
        is_number = (
            isinstance(threshold, (int, float)) and
            not isinstance(threshold, bool) and
            np.isfinite(threshold) and
            0.0 <= float(threshold) <= 1.0
        )
        accepted_values.append(
            bool(is_number and confidence[index] >= float(threshold))
        )
    accepted = np.array(accepted_values, dtype=bool)
    coverage = float(np.mean(accepted)) if len(accepted) else 0.0
    accuracy = float(np.mean(predicted[accepted] == truth[accepted])) if np.any(accepted) else 0.0
    details: dict[str, Any] = {
        "coverage": coverage,
        "accepted": int(np.sum(accepted)),
        "total": int(len(accepted)),
        "accuracy": accuracy,
    }
    per_class: dict[str, Any] = {}
    for label, label_id in LABEL2ID.items():
        mask = accepted & (predicted == label_id)
        per_class[label] = {
            "accepted": int(np.sum(mask)),
            "precision": float(np.mean(truth[mask] == label_id)) if np.any(mask) else None,
        }
    details["per_class"] = per_class
    return details


def accepted_mask(
    probabilities: np.ndarray,
    thresholds: dict[str, float | None],
) -> np.ndarray:
    """Return the exact per-example deployment acceptance decision."""
    predicted = np.argmax(probabilities, axis=1)
    confidence = np.max(probabilities, axis=1)
    accepted = []
    for index, label_id in enumerate(predicted):
        threshold = thresholds.get(LABELS[label_id])
        is_number = (
            isinstance(threshold, (int, float))
            and not isinstance(threshold, bool)
            and np.isfinite(threshold)
            and 0.0 <= float(threshold) <= 1.0
        )
        accepted.append(
            bool(is_number and confidence[index] >= float(threshold))
        )
    return np.asarray(accepted, dtype=bool)


def threshold_tradeoffs(
    probabilities: np.ndarray,
    truth: np.ndarray,
    maximum_points: int = 80,
) -> dict[str, list[dict[str, float | int]]]:
    """Describe precision/coverage at candidate thresholds for each label."""
    predicted = np.argmax(probabilities, axis=1)
    tradeoffs: dict[str, list[dict[str, float | int]]] = {}
    total = max(1, len(truth))
    for label, label_id in LABEL2ID.items():
        indices = np.flatnonzero(predicted == label_id)
        if not len(indices):
            tradeoffs[label] = []
            continue
        scores = probabilities[indices, label_id]
        unique_thresholds = np.unique(scores)[::-1]
        if len(unique_thresholds) > maximum_points:
            positions = np.linspace(
                0,
                len(unique_thresholds) - 1,
                maximum_points,
                dtype=int,
            )
            unique_thresholds = unique_thresholds[positions]
        points: list[dict[str, float | int]] = []
        for threshold in unique_thresholds:
            accepted = indices[scores >= threshold]
            correct = truth[accepted] == label_id
            points.append(
                {
                    "threshold": float(threshold),
                    "accepted": int(len(accepted)),
                    "precision": float(np.mean(correct)),
                    "coverage": float(len(accepted) / total),
                }
            )
        tradeoffs[label] = points
    return tradeoffs


def error_examples(
    selected: list[dict[str, Any]],
    probabilities: np.ndarray,
    truth: np.ndarray,
    thresholds: dict[str, float | None],
    limit: int = 100,
) -> tuple[list[dict[str, Any]], int]:
    """Return the highest-confidence mistakes with enough context to audit."""
    predicted = np.argmax(probabilities, axis=1)
    confidence = np.max(probabilities, axis=1)
    accepted = accepted_mask(probabilities, thresholds)
    mistake_indices = np.flatnonzero(predicted != truth)
    ordered = mistake_indices[np.argsort(confidence[mistake_indices])[::-1]]
    rows: list[dict[str, Any]] = []
    for index in ordered[:limit]:
        example = selected[int(index)]
        rows.append(
            {
                "id": example.get("id"),
                "group_id": example.get("group_id"),
                "source": example.get("source"),
                "text": example.get("text"),
                "evidence": example.get("evidence"),
                "truth": LABELS[int(truth[index])],
                "predicted": LABELS[int(predicted[index])],
                "confidence": float(confidence[index]),
                "accepted": bool(accepted[index]),
                "probabilities": {
                    label: float(probabilities[index, label_id])
                    for label, label_id in LABEL2ID.items()
                },
            }
        )
    return rows, int(len(mistake_indices))


def research_checkpoint_sha256(model_path: Path, max_length: int) -> str:
    """Bind research thresholds to exact weights, tokenizer, labels, and length."""
    filenames = (
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "vocab.txt",
        "model.safetensors",
        "pytorch_model.bin",
    )
    tracked = [filename for filename in filenames if (model_path / filename).is_file()]
    if "config.json" not in tracked or not any(
        filename in tracked for filename in ("model.safetensors", "pytorch_model.bin")
    ):
        raise ValueError("research checkpoint is missing config or model weights")
    files = build_file_manifest(model_path, tracked)
    return deployment_sha256(
        "research-pytorch-checkpoint",
        list(LABELS),
        max_length,
        files,
    )


def infer_pytorch(
    model_path: Path,
    texts: list[str],
    max_length: int,
    batch_size: int,
) -> tuple[np.ndarray, dict[str, float]]:
    startup_started = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(model_path, use_fast=True)
    model = AutoModelForSequenceClassification.from_pretrained(model_path)
    device = torch.device(
        "mps"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
        else "cpu"
    )
    model.to(device)
    model.eval()
    startup_seconds = time.perf_counter() - startup_started
    logits: list[np.ndarray] = []
    inference_started = time.perf_counter()
    with torch.inference_mode():
        for start in range(0, len(texts), batch_size):
            batch = tokenizer(
                texts[start : start + batch_size],
                padding=True,
                truncation=True,
                max_length=max_length,
                return_tensors="pt",
            )
            batch = {key: value.to(device) for key, value in batch.items()}
            output = model(**batch).logits.detach().cpu().numpy()
            logits.append(output)
    inference_seconds = time.perf_counter() - inference_started
    return np.concatenate(logits, axis=0), {
        "startup_seconds": startup_seconds,
        "inference_seconds": inference_seconds,
    }


def infer_onnx(
    tokenizer_path: Path,
    onnx_path: Path,
    texts: list[str],
    max_length: int,
    batch_size: int,
) -> tuple[np.ndarray, dict[str, float]]:
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise SystemExit(
            "onnxruntime is required to evaluate the exported model"
        ) from error

    startup_started = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(tokenizer_path, use_fast=True)
    session = ort.InferenceSession(
        str(onnx_path),
        providers=["CPUExecutionProvider"],
    )
    input_names = {item.name for item in session.get_inputs()}
    startup_seconds = time.perf_counter() - startup_started
    logits: list[np.ndarray] = []
    inference_started = time.perf_counter()
    for start in range(0, len(texts), batch_size):
        encoded = tokenizer(
            texts[start : start + batch_size],
            padding=True,
            truncation=True,
            max_length=max_length,
            return_tensors="np",
        )
        feeds = {
            key: np.asarray(value, dtype=np.int64)
            for key, value in encoded.items()
            if key in input_names
        }
        logits.append(np.asarray(session.run(None, feeds)[0]))
    inference_seconds = time.perf_counter() - inference_started
    return np.concatenate(logits, axis=0), {
        "startup_seconds": startup_seconds,
        "inference_seconds": inference_seconds,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument(
        "--onnx",
        type=Path,
        help="Evaluate this exact exported ONNX graph instead of PyTorch weights.",
    )
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument(
        "--split",
        choices=("validation", "test", "challenge"),
        required=True,
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--thresholds", type=Path)
    parser.add_argument("--target-precision", type=float, default=0.97)
    parser.add_argument("--minimum-predictions", type=int, default=10)
    parser.add_argument(
        "--max-length",
        type=int,
        help="Research override. Packaged ONNX evaluation uses artifact.json.",
    )
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--include-unverified", action="store_true")
    parser.add_argument(
        "--allow-pytorch-thresholds",
        action="store_true",
        help="Research only: allow threshold selection before ONNX quantization.",
    )
    args = parser.parse_args()

    if not 0.0 < args.target_precision <= 1.0:
        raise SystemExit("--target-precision must be greater than 0 and at most 1")
    if args.minimum_predictions < 1:
        raise SystemExit("--minimum-predictions must be at least 1")
    if not args.thresholds and args.split != "validation":
        raise SystemExit("new thresholds may be selected only on the validation split")
    if not args.thresholds and not args.onnx and not args.allow_pytorch_thresholds:
        raise SystemExit(
            "select deployment thresholds from the quantized artifact with --onnx; "
            "use --allow-pytorch-thresholds only for research"
        )

    try:
        validate_runtime_gate(args.data)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    examples, errors, warnings = validate_dataset(load_jsonl(args.data))
    for warning in warnings:
        print(f"warning: {warning}")
    if errors:
        raise SystemExit("\n".join(errors))
    verified_only = not args.include_unverified
    if verified_only:
        excluded = sum(not example["verified"] for example in examples)
        if excluded:
            print(f"warning: excluding {excluded} unverified examples")
        examples = [example for example in examples if example["verified"]]
    selected = select_split(examples, args.split)
    if not selected:
        raise SystemExit(f"split {args.split!r} contains no examples")

    truth = np.array([LABEL2ID[example["label"]] for example in selected])
    texts = [example["text"] for example in selected]

    input_threshold_payload = None
    if args.thresholds:
        input_threshold_payload = json.loads(
            args.thresholds.read_text(encoding="utf-8")
        )
        try:
            thresholds = validate_thresholds(
                input_threshold_payload.get(
                    "thresholds", input_threshold_payload
                ),
                LABELS,
            )
        except ValueError as error:
            raise SystemExit(str(error)) from error
    else:
        thresholds = None

    if args.onnx:
        try:
            artifact = validate_artifact_directory(args.model, args.onnx)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            raise SystemExit(str(error)) from error
        if artifact["labels"] != list(LABELS):
            raise SystemExit("artifact label order does not match SponsorLens labels")
        artifact_max_length = int(artifact["max_length"])
        if args.max_length is not None and args.max_length != artifact_max_length:
            raise SystemExit(
                "--max-length does not match the packaged artifact manifest"
            )
        max_length = artifact_max_length
        deployment_hash = artifact["deployment_sha256"]
        if input_threshold_payload is not None:
            if input_threshold_payload.get("deployment_sha256") != deployment_hash:
                raise SystemExit("thresholds belong to a different deployment artifact")
            if input_threshold_payload.get("selected_on") != "validation":
                raise SystemExit("deployment thresholds must be selected on validation")
            if not str(input_threshold_payload.get("runtime", "")).startswith(
                "onnxruntime"
            ):
                raise SystemExit("deployment thresholds must be measured with ONNX")
            if input_threshold_payload.get("verified_only") is not True:
                raise SystemExit("deployment thresholds must use verified examples only")
        logits, timing = infer_onnx(
            args.model,
            args.onnx,
            texts,
            max_length=max_length,
            batch_size=args.batch_size,
        )
        runtime = "onnxruntime-cpu"
    else:
        max_length = args.max_length or 192
        deployment_hash = None
        try:
            checkpoint_hash = research_checkpoint_sha256(args.model, max_length)
        except (OSError, ValueError) as error:
            raise SystemExit(str(error)) from error
        if input_threshold_payload is not None:
            if input_threshold_payload.get("model_sha256") != checkpoint_hash:
                raise SystemExit("thresholds belong to a different PyTorch checkpoint")
            if input_threshold_payload.get("selected_on") != "validation":
                raise SystemExit("research thresholds must be selected on validation")
            if input_threshold_payload.get("runtime") != "pytorch":
                raise SystemExit("research thresholds must be measured with PyTorch")
            if input_threshold_payload.get("verified_only") is not verified_only:
                raise SystemExit(
                    "threshold verification policy does not match this evaluation"
                )
        logits, timing = infer_pytorch(
            args.model,
            texts,
            max_length=max_length,
            batch_size=args.batch_size,
        )
        runtime = "pytorch"
    if args.onnx:
        checkpoint_hash = None
    if not np.all(np.isfinite(logits)):
        raise SystemExit("model produced non-finite logits; refusing to report metrics")
    inference_seconds = timing["inference_seconds"]
    startup_seconds = timing["startup_seconds"]
    probabilities = softmax(logits)
    if not np.all(np.isfinite(probabilities)):
        raise SystemExit(
            "model produced non-finite probabilities; refusing to calibrate"
        )
    predicted = np.argmax(probabilities, axis=1)

    if thresholds is None:
        thresholds = select_thresholds(
            probabilities,
            truth,
            target_precision=args.target_precision,
            minimum_predictions=args.minimum_predictions,
        )

    precision, recall, f1, support = precision_recall_fscore_support(
        truth,
        predicted,
        labels=list(range(len(LABELS))),
        zero_division=0,
    )
    report = classification_report(
        truth,
        predicted,
        labels=list(range(len(LABELS))),
        target_names=list(LABELS),
        output_dict=True,
        zero_division=0,
    )
    mistakes, mistake_count = error_examples(
        selected,
        probabilities,
        truth,
        thresholds,
    )
    if args.onnx:
        model_bytes = args.onnx.stat().st_size
    else:
        weight_files = [
            path
            for filename in ("model.safetensors", "pytorch_model.bin")
            if (path := args.model / filename).is_file()
        ]
        model_bytes = sum(path.stat().st_size for path in weight_files)
    metrics = {
        "split": args.split,
        "runtime": runtime,
        "deployment_sha256": deployment_hash,
        "model_sha256": checkpoint_hash,
        "max_length": max_length,
        "verified_only": verified_only,
        "examples": len(selected),
        "accuracy": float(np.mean(predicted == truth)),
        "macro_f1": float(np.mean(f1)),
        "expected_calibration_error": expected_calibration_error(probabilities, truth),
        "multiclass_brier_score": brier_score(probabilities, truth),
        "inference": {
            "seconds": inference_seconds,
            "startup_seconds": startup_seconds,
            "total_seconds": startup_seconds + inference_seconds,
            "milliseconds_per_example": (
                inference_seconds * 1000.0 / len(selected)
            ),
            "examples_per_second": (
                len(selected) / inference_seconds
                if inference_seconds > 0
                else None
            ),
            "model_bytes": model_bytes,
            "measurement": (
                "startup is tokenizer/runtime/model loading; throughput is "
                "batched inference after loading"
            ),
        },
        "per_class": {
            label: {
                "precision": float(precision[index]),
                "recall": float(recall[index]),
                "f1": float(f1[index]),
                "support": int(support[index]),
            }
            for index, label in enumerate(LABELS)
        },
        "confusion_matrix": confusion_matrix(
            truth,
            predicted,
            labels=list(range(len(LABELS))),
        ).tolist(),
        "classification_report": report,
        "accepted_decisions": accepted_metrics(probabilities, truth, thresholds),
        "threshold_tradeoffs": threshold_tradeoffs(probabilities, truth),
        "mistake_count": mistake_count,
        "error_examples": mistakes,
        "error_examples_limit": 100,
    }
    threshold_payload = {
        "model": args.model.name,
        "runtime": runtime,
        "deployment_sha256": deployment_hash,
        "model_sha256": checkpoint_hash,
        "selected_on": (
            input_threshold_payload.get("selected_on")
            if input_threshold_payload is not None
            else args.split
        ),
        "evaluated_on": args.split,
        "verified_only": verified_only,
        "target_precision": (
            input_threshold_payload.get("target_precision")
            if input_threshold_payload is not None
            else args.target_precision
        ),
        "minimum_predictions": (
            input_threshold_payload.get("minimum_predictions")
            if input_threshold_payload is not None
            else args.minimum_predictions
        ),
        "thresholds": thresholds,
    }

    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "metrics.json").write_text(
        json.dumps(metrics, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    (args.output / "thresholds.json").write_text(
        json.dumps(
            threshold_payload,
            indent=2,
            sort_keys=True,
            allow_nan=False,
        ) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(metrics, indent=2, sort_keys=True))
    print(json.dumps(threshold_payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
