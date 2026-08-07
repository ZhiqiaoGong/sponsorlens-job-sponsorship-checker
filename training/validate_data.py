#!/usr/bin/env python3
"""Validate SponsorLens JSONL data and guard against split leakage."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from data_utils import (
    LABELS,
    SPLITS,
    load_jsonl,
    validate_runtime_gate,
    with_assigned_splits,
)


REQUIRED_FIELDS = {
    "id",
    "group_id",
    "text",
    "label",
    "evidence",
    "source",
    "verified",
}
OPTIONAL_FIELDS = {"rule_id", "split", "metadata", "_line"}


def normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def fingerprint(value: str) -> str:
    return hashlib.sha256(normalized_text(value).encode("utf-8")).hexdigest()


def validate_example(example: dict[str, Any]) -> list[str]:
    line = example.get("_line", "?")
    prefix = f"line {line}"
    errors: list[str] = []
    missing = sorted(REQUIRED_FIELDS - set(example))
    if missing:
        errors.append(f"{prefix}: missing fields: {', '.join(missing)}")
        return errors
    unexpected = sorted(set(example) - REQUIRED_FIELDS - OPTIONAL_FIELDS)
    if unexpected:
        errors.append(f"{prefix}: unknown fields: {', '.join(unexpected)}")

    if not isinstance(example["id"], str) or len(example["id"].strip()) < 3:
        errors.append(f"{prefix}: id must be a non-empty string")
    if not isinstance(example["group_id"], str) or len(example["group_id"].strip()) < 3:
        errors.append(f"{prefix}: group_id must be a non-empty string")
    if not isinstance(example["text"], str) or len(example["text"].strip()) < 3:
        errors.append(f"{prefix}: text must contain at least three characters")
    elif len(example["text"]) > 4000:
        errors.append(f"{prefix}: text exceeds the 4,000-character window limit")
    if example["label"] not in LABELS:
        errors.append(f"{prefix}: invalid label {example['label']!r}")
    if not isinstance(example["source"], str) or not example["source"].strip():
        errors.append(f"{prefix}: source must be a non-empty string")
    if not isinstance(example["verified"], bool):
        errors.append(f"{prefix}: verified must be true or false")
    if example.get("rule_id") is not None and not isinstance(
        example.get("rule_id"), str
    ):
        errors.append(f"{prefix}: rule_id must be a string or null")
    if example.get("metadata") is not None and not isinstance(
        example.get("metadata"), dict
    ):
        errors.append(f"{prefix}: metadata must be an object")
    if example.get("split") is not None and example["split"] not in SPLITS:
        errors.append(f"{prefix}: invalid split {example['split']!r}")

    evidence = example["evidence"]
    if example["label"] == "irrelevant":
        if evidence is not None:
            errors.append(f"{prefix}: irrelevant examples must have null evidence")
        return errors

    if not isinstance(evidence, dict):
        errors.append(f"{prefix}: non-irrelevant examples require evidence")
        return errors
    if set(("start", "end", "text")) - set(evidence):
        errors.append(f"{prefix}: evidence requires start, end, and text")
        return errors
    start = evidence.get("start")
    end = evidence.get("end")
    evidence_text = evidence.get("text")
    if not isinstance(start, int) or not isinstance(end, int):
        errors.append(f"{prefix}: evidence offsets must be integers")
    elif not (0 <= start < end <= len(example["text"])):
        errors.append(f"{prefix}: evidence offsets are outside the text")
    elif example["text"][start:end] != evidence_text:
        errors.append(f"{prefix}: evidence.text does not match text[start:end]")
    if not isinstance(evidence_text, str) or not evidence_text:
        errors.append(f"{prefix}: evidence.text must be non-empty")
    return errors


def validate_dataset(
    examples: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    ids: dict[str, int] = {}
    group_splits: dict[str, str] = {}
    exact_text: dict[str, tuple[str, str, int]] = {}

    for example in examples:
        errors.extend(validate_example(example))
        example_id = str(example.get("id", ""))
        if example_id in ids:
            errors.append(
                f"line {example.get('_line')}: duplicate id {example_id!r}; "
                f"first seen on line {ids[example_id]}"
            )
        else:
            ids[example_id] = int(example.get("_line", 0))

    if errors:
        return examples, errors, warnings

    try:
        assigned = with_assigned_splits(examples)
    except ValueError as error:
        errors.append(str(error))
        return examples, errors, warnings

    for example in assigned:
        group_id = example["group_id"]
        split = example["split"]
        prior_split = group_splits.setdefault(group_id, split)
        if prior_split != split:
            errors.append(
                f"group_id {group_id!r} crosses {prior_split!r} and {split!r}"
            )

        text_hash = fingerprint(example["text"])
        prior = exact_text.get(text_hash)
        if prior:
            if prior[1] != example["label"]:
                errors.append(
                    f"identical text has conflicting labels on lines {prior[2]} "
                    f"and {example['_line']} ({prior[1]} vs {example['label']})"
                )
            elif prior[0] != split:
                errors.append(
                    f"exact duplicate text crosses splits on lines {prior[2]} and "
                    f"{example['_line']} ({prior[0]} vs {split})"
                )
            else:
                errors.append(
                    f"duplicate text appears more than once on lines {prior[2]} "
                    f"and {example['_line']}"
                )
        else:
            exact_text[text_hash] = (split, example["label"], example["_line"])

    # Near-duplicate detection is intentionally a warning. Human review decides
    # whether two boilerplate variants belong to one group.
    for left_index, left in enumerate(assigned):
        left_text = normalized_text(left["text"])
        for right in assigned[left_index + 1 :]:
            if left["split"] == right["split"] or left["group_id"] == right["group_id"]:
                continue
            right_text = normalized_text(right["text"])
            if abs(len(left_text) - len(right_text)) > 80:
                continue
            ratio = SequenceMatcher(None, left_text, right_text).ratio()
            if ratio >= 0.92:
                warnings.append(
                    f"possible near duplicate across splits: lines {left['_line']} "
                    f"and {right['_line']} (similarity {ratio:.3f})"
                )

    return assigned, errors, warnings


def summarize(examples: list[dict[str, Any]]) -> dict[str, Any]:
    by_split: dict[str, Counter[str]] = defaultdict(Counter)
    groups: dict[str, set[str]] = defaultdict(set)
    for example in examples:
        split = example["split"]
        by_split[split][example["label"]] += 1
        groups[split].add(example["group_id"])
    return {
        "examples": len(examples),
        "verified": sum(bool(example["verified"]) for example in examples),
        "splits": {
            split: {
                "examples": sum(by_split[split].values()),
                "groups": len(groups[split]),
                "labels": {label: by_split[split][label] for label in LABELS},
            }
            for split in SPLITS
            if by_split[split]
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("data", type=Path)
    args = parser.parse_args()

    try:
        examples = load_jsonl(args.data)
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    assigned, errors, warnings = validate_dataset(examples)
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    try:
        validate_runtime_gate(args.data)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(summarize(assigned), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
