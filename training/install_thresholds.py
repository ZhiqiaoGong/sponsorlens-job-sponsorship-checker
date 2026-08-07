#!/usr/bin/env python3
"""Install validation thresholds that were measured on an exact ONNX artifact."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from artifact_utils import validate_artifact_directory, validate_thresholds
from data_utils import LABELS


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--thresholds", type=Path, required=True)
    args = parser.parse_args()

    model_files = list((args.artifact / "onnx").glob("*.onnx"))
    if len(model_files) != 1:
        raise SystemExit("artifact must contain artifact.json and exactly one ONNX model")

    artifact_path = args.artifact / "artifact.json"
    try:
        artifact = validate_artifact_directory(args.artifact, model_files[0])
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(str(error)) from error
    payload = json.loads(args.thresholds.read_text(encoding="utf-8"))
    try:
        thresholds = validate_thresholds(payload.get("thresholds"), LABELS)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    if payload.get("selected_on") != "validation":
        raise SystemExit("thresholds must be selected on the validation split")
    if not str(payload.get("runtime", "")).startswith("onnxruntime"):
        raise SystemExit("thresholds must be measured with the exported ONNX graph")
    if payload.get("verified_only") is not True:
        raise SystemExit("thresholds must be selected from verified examples only")

    deployment_hash = artifact["deployment_sha256"]
    if payload.get("deployment_sha256") != deployment_hash:
        raise SystemExit("thresholds were measured on a different deployment artifact")

    artifact["thresholds"] = thresholds
    artifact["calibration"] = {
        "runtime": payload["runtime"],
        "selected_on": "validation",
        "target_precision": payload.get("target_precision"),
        "minimum_predictions": payload.get("minimum_predictions"),
        "deployment_sha256": deployment_hash,
        "verified_only": True,
    }
    artifact["release_ready"] = False
    artifact_path.write_text(
        json.dumps(artifact, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (args.artifact / "thresholds.json").write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(artifact, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
