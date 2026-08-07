#!/usr/bin/env python3
"""Export and dynamically quantize a validated SponsorLens checkpoint."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from artifact_utils import (
    build_file_manifest,
    deployment_sha256,
    validate_artifact_directory,
)
from data_utils import LABELS


TOKENIZER_FILES = (
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.txt",
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", default="sponsorlens-local-v1")
    parser.add_argument("--max-length", type=int, default=192)
    args = parser.parse_args()

    try:
        from optimum.onnxruntime import ORTQuantizer
        from optimum.onnxruntime.configuration import AutoQuantizationConfig
    except ImportError as error:
        raise SystemExit(
            "ONNX export dependencies are missing. Install "
            "training/requirements.txt first."
        ) from error

    thresholds = {label: None for label in LABELS}

    args.output.mkdir(parents=True, exist_ok=True)
    fp32_directory = args.output / "onnx_fp32"
    quantized_directory = args.output / "onnx"
    if fp32_directory.exists() or quantized_directory.exists():
        raise SystemExit(
            "output already contains ONNX files; choose a clean artifact directory"
        )

    subprocess.run(
        [
            sys.executable,
            "-m",
            "optimum.exporters.onnx",
            "--model",
            str(args.model),
            "--task",
            "text-classification",
            "--opset",
            "17",
            str(fp32_directory),
        ],
        check=True,
    )
    onnx_files = list(fp32_directory.rglob("*.onnx"))
    if len(onnx_files) != 1:
        raise SystemExit(
            f"expected one exported ONNX graph, found {len(onnx_files)}"
        )

    quantizer = ORTQuantizer.from_pretrained(
        onnx_files[0].parent,
        file_name=onnx_files[0].name,
    )
    configuration = AutoQuantizationConfig.avx2(
        is_static=False,
        per_channel=False,
    )
    quantizer.quantize(
        save_dir=quantized_directory,
        quantization_config=configuration,
    )
    shutil.rmtree(fp32_directory)
    quantized_files = list(quantized_directory.rglob("*.onnx"))
    if len(quantized_files) != 1:
        raise SystemExit(
            f"expected one quantized ONNX graph, found {len(quantized_files)}"
        )
    packaged_files = [quantized_files[0].relative_to(args.output).as_posix()]
    for filename in TOKENIZER_FILES:
        source = args.model / filename
        if source.exists():
            shutil.copy2(source, args.output / filename)
            packaged_files.append(filename)
    files = build_file_manifest(args.output, packaged_files)
    package_hash = deployment_sha256(
        args.version,
        list(LABELS),
        args.max_length,
        files,
    )

    threshold_payload = {
        "model": args.version,
        "selected_on": None,
        "runtime": None,
        "deployment_sha256": package_hash,
        "verified_only": None,
        "thresholds": thresholds,
    }
    (args.output / "thresholds.json").write_text(
        json.dumps(threshold_payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    artifact = {
        "version": args.version,
        "task": "text-classification",
        "labels": list(LABELS),
        "max_length": args.max_length,
        "quantization": "dynamic-int8",
        "files": files,
        "deployment_sha256": package_hash,
        "thresholds": thresholds,
        "release_ready": False,
    }
    (args.output / "artifact.json").write_text(
        json.dumps(artifact, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    validate_artifact_directory(args.output, quantized_files[0])
    (args.output / "model-card.md").write_text(
        "# SponsorLens local classifier\n\n"
        f"- Version: `{args.version}`\n"
        "- Task: five-class sponsorship evidence-window classification\n"
        "- Runtime: packaged ONNX, dynamic int8\n"
        "- Network access: none\n"
        "- Calibration: pending evaluation of this quantized artifact\n"
        "- Release status: not approved until independent held-out evaluation\n",
        encoding="utf-8",
    )
    print(json.dumps(artifact, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
