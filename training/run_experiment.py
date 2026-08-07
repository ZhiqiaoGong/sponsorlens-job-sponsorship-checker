#!/usr/bin/env python3
"""Run a reproducible, observable SponsorLens classifier experiment."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from data_utils import load_jsonl
from validate_data import validate_dataset


TRAINING_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TRAINING_DIR.parent
SEED_DATA = TRAINING_DIR / "data" / "seed.jsonl"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def run_stage(
    name: str,
    command: list[str],
    log_path: Path,
    manifest: dict[str, Any],
    manifest_path: Path,
    *,
    record_in_manifest: bool = True,
) -> None:
    """Stream a stage to the terminal while retaining an exact local log."""
    stage: dict[str, Any] = {
        "name": name,
        "status": "running",
        "started_at": utc_now(),
        "command": command,
        "log": str(log_path),
    }
    if record_in_manifest:
        manifest["stages"].append(stage)
        write_manifest(manifest_path, manifest)

    dataset = Path(str(manifest["data"]))
    current_hash = file_sha256(dataset)
    if current_hash != manifest["data_sha256"]:
        stage["status"] = "failed"
        stage["finished_at"] = utc_now()
        stage["error"] = "dataset changed after the experiment started"
        if record_in_manifest:
            write_manifest(manifest_path, manifest)
        raise RuntimeError(stage["error"])

    banner = f"\n{'=' * 72}\n{name}\n$ {shlex.join(command)}\n{'=' * 72}"
    print(banner, flush=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    try:
        with log_path.open("w", encoding="utf-8") as log:
            log.write(banner + "\n")
            log.flush()
            process = subprocess.Popen(
                command,
                cwd=PROJECT_DIR,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            assert process.stdout is not None
            for line in process.stdout:
                print(line, end="", flush=True)
                log.write(line)
                log.flush()
            return_code = process.wait()
        if return_code:
            raise subprocess.CalledProcessError(return_code, command)
    except BaseException as error:
        stage["status"] = (
            "interrupted" if isinstance(error, KeyboardInterrupt) else "failed"
        )
        stage["error"] = str(error)
        raise
    else:
        stage["status"] = "completed"
    finally:
        stage["finished_at"] = utc_now()
        stage["duration_seconds"] = round(time.perf_counter() - started, 3)
        if record_in_manifest:
            write_manifest(manifest_path, manifest)


def available_splits(data: Path, include_unverified: bool) -> set[str]:
    examples, errors, _ = validate_dataset(load_jsonl(data))
    if errors:
        raise ValueError("\n".join(errors))
    if not include_unverified:
        examples = [example for example in examples if example["verified"]]
    return {str(example["split"]) for example in examples}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Validate, train, evaluate, and render a local HTML audit report. "
            "Every subprocess is streamed and logged."
        )
    )
    parser.add_argument("--data", type=Path)
    parser.add_argument("--run-name")
    parser.add_argument(
        "--mode",
        choices=("research", "deployment"),
        default="research",
        help=(
            "research evaluates PyTorch weights; deployment additionally "
            "exports and calibrates the exact quantized ONNX artifact"
        ),
    )
    parser.add_argument(
        "--smoke",
        action="store_true",
        help="Use the checked-in seed contract for a one-epoch pipeline demo.",
    )
    parser.add_argument("--base-model", default="google/bert_uncased_L-4_H-256_A-4")
    parser.add_argument(
        "--base-revision",
        help="Optional immutable Hugging Face commit/tag for reproducibility.",
    )
    parser.add_argument("--max-length", type=int, default=192)
    parser.add_argument("--epochs", type=float)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=3e-5)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--target-precision", type=float, default=0.97)
    parser.add_argument("--minimum-predictions", type=int)
    parser.add_argument("--include-unverified", action="store_true")
    parser.add_argument(
        "--output-root",
        type=Path,
        default=TRAINING_DIR / "output",
    )
    parser.add_argument(
        "--report-root",
        type=Path,
        default=TRAINING_DIR / "reports",
    )
    return parser.parse_args(argv)


def resolve_args(args: argparse.Namespace) -> argparse.Namespace:
    if args.smoke:
        args.data = (args.data or SEED_DATA).resolve()
        args.epochs = args.epochs if args.epochs is not None else 1.0
        args.minimum_predictions = (
            args.minimum_predictions
            if args.minimum_predictions is not None
            else 2
        )
    else:
        if args.data is None:
            raise ValueError("--data is required unless --smoke is used")
        args.data = args.data.resolve()
        if args.data == SEED_DATA.resolve():
            raise ValueError(
                "seed.jsonl is only a pipeline demo; pass --smoke explicitly"
            )
        args.epochs = args.epochs if args.epochs is not None else 5.0
        args.minimum_predictions = (
            args.minimum_predictions
            if args.minimum_predictions is not None
            else 10
        )
    if not args.data.is_file():
        raise ValueError(f"dataset does not exist: {args.data}")
    if args.max_length < 1:
        raise ValueError("--max-length must be at least one")
    if args.epochs <= 0 or not math.isfinite(args.epochs):
        raise ValueError("--epochs must be a finite number greater than zero")
    if args.batch_size < 1:
        raise ValueError("--batch-size must be at least one")
    if args.learning_rate <= 0 or not math.isfinite(args.learning_rate):
        raise ValueError(
            "--learning-rate must be a finite number greater than zero"
        )
    if args.minimum_predictions < 1:
        raise ValueError("--minimum-predictions must be at least one")
    if not 0.0 < args.target_precision <= 1.0:
        raise ValueError("--target-precision must be in (0, 1]")
    if args.mode == "deployment" and args.include_unverified:
        raise ValueError(
            "deployment calibration requires verified-only data; "
            "remove --include-unverified or use --mode research"
        )
    if args.run_name is None:
        prefix = "smoke" if args.smoke else "experiment"
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        args.run_name = f"{prefix}-{timestamp}"
    if not args.run_name.strip() or args.run_name in {".", ".."}:
        raise ValueError("--run-name must be a non-empty directory name")
    if any(character in args.run_name for character in ("/", "\\")):
        raise ValueError("--run-name must be a single directory name")
    if args.output_root.resolve() == args.report_root.resolve():
        raise ValueError("--output-root and --report-root must be different")
    return args


def main(argv: list[str] | None = None) -> int:
    try:
        args = resolve_args(parse_args(argv))
        splits = available_splits(args.data, args.include_unverified)
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from error

    output_dir = args.output_root.resolve() / args.run_name
    report_dir = args.report_root.resolve() / args.run_name
    if output_dir.exists() or report_dir.exists():
        raise SystemExit(
            "run output already exists; choose a new --run-name to preserve history"
        )
    checkpoint_dir = output_dir / "checkpoint"
    artifact_dir = output_dir / "artifact"
    evaluations_dir = report_dir / "evaluations"
    logs_dir = report_dir / "logs"
    report_dir.mkdir(parents=True)
    output_dir.mkdir(parents=True)
    manifest_path = report_dir / "run.json"
    python = sys.executable
    manifest: dict[str, Any] = {
        "schema_version": 1,
        "run_name": args.run_name,
        "status": "running",
        "started_at": utc_now(),
        "mode": args.mode,
        "research_only": True,
        "smoke": args.smoke,
        "data": str(args.data),
        "data_sha256": file_sha256(args.data),
        "available_splits": sorted(splits),
        "configuration": {
            "base_model": args.base_model,
            "base_revision": args.base_revision,
            "max_length": args.max_length,
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "learning_rate": args.learning_rate,
            "seed": args.seed,
            "target_precision": args.target_precision,
            "minimum_predictions": args.minimum_predictions,
            "include_unverified": args.include_unverified,
        },
        "stages": [],
    }
    write_manifest(manifest_path, manifest)

    common_verified = ["--include-unverified"] if args.include_unverified else []
    try:
        run_stage(
            "Validate dataset and runtime windows",
            [python, str(TRAINING_DIR / "validate_data.py"), str(args.data)],
            logs_dir / "01-validate.log",
            manifest,
            manifest_path,
        )
        train_command = [
            python,
            str(TRAINING_DIR / "train.py"),
            "--data",
            str(args.data),
            "--output",
            str(checkpoint_dir),
            "--base-model",
            args.base_model,
            "--max-length",
            str(args.max_length),
            "--epochs",
            str(args.epochs),
            "--batch-size",
            str(args.batch_size),
            "--learning-rate",
            str(args.learning_rate),
            "--seed",
            str(args.seed),
            *common_verified,
        ]
        if args.base_revision:
            train_command.extend(("--base-revision", args.base_revision))
        run_stage(
            "Fine-tune classifier",
            train_command,
            logs_dir / "02-train.log",
            manifest,
            manifest_path,
        )

        if args.mode == "deployment":
            run_stage(
                "Export dynamic-int8 ONNX artifact",
                [
                    python,
                    str(TRAINING_DIR / "export_onnx.py"),
                    "--model",
                    str(checkpoint_dir),
                    "--output",
                    str(artifact_dir),
                    "--version",
                    args.run_name,
                    "--max-length",
                    str(args.max_length),
                ],
                logs_dir / "03-export.log",
                manifest,
                manifest_path,
            )
            onnx_files = list((artifact_dir / "onnx").glob("*.onnx"))
            if len(onnx_files) != 1:
                raise RuntimeError("export did not produce exactly one ONNX graph")
            evaluation_model = artifact_dir
            runtime_arguments = ["--onnx", str(onnx_files[0])]
        else:
            manifest["stages"].append(
                {
                    "name": "Export dynamic-int8 ONNX artifact",
                    "status": "skipped",
                    "reason": "research mode",
                }
            )
            write_manifest(manifest_path, manifest)
            evaluation_model = checkpoint_dir
            runtime_arguments = [
                "--max-length",
                str(args.max_length),
                "--allow-pytorch-thresholds",
            ]

        validation_dir = evaluations_dir / "validation"
        validation_command = [
            python,
            str(TRAINING_DIR / "evaluate.py"),
            "--model",
            str(evaluation_model),
            *runtime_arguments,
            "--data",
            str(args.data),
            "--split",
            "validation",
            "--output",
            str(validation_dir),
            "--target-precision",
            str(args.target_precision),
            "--minimum-predictions",
            str(args.minimum_predictions),
            *common_verified,
        ]
        run_stage(
            "Select validation thresholds",
            validation_command,
            logs_dir / "04-validation.log",
            manifest,
            manifest_path,
        )

        if args.mode == "deployment":
            run_stage(
                "Install thresholds into exact ONNX artifact",
                [
                    python,
                    str(TRAINING_DIR / "install_thresholds.py"),
                    "--artifact",
                    str(artifact_dir),
                    "--thresholds",
                    str(validation_dir / "thresholds.json"),
                ],
                logs_dir / "04b-install-thresholds.log",
                manifest,
                manifest_path,
            )
            threshold_path = artifact_dir / "thresholds.json"
            runtime_arguments = ["--onnx", str(onnx_files[0])]
        else:
            threshold_path = validation_dir / "thresholds.json"
            runtime_arguments = ["--max-length", str(args.max_length)]

        for split in ("test", "challenge"):
            if split not in splits:
                continue
            run_stage(
                f"Evaluate held-out {split} split",
                [
                    python,
                    str(TRAINING_DIR / "evaluate.py"),
                    "--model",
                    str(evaluation_model),
                    *runtime_arguments,
                    "--data",
                    str(args.data),
                    "--split",
                    split,
                    "--thresholds",
                    str(threshold_path),
                    "--output",
                    str(evaluations_dir / split),
                    *common_verified,
                ],
                logs_dir / f"05-{split}.log",
                manifest,
                manifest_path,
            )

        report_command = [
            python,
            str(TRAINING_DIR / "report.py"),
            "--data",
            str(args.data),
            "--run",
            str(manifest_path),
            "--training",
            str(checkpoint_dir),
            "--evaluations",
            str(evaluations_dir),
            "--output",
            str(report_dir / "index.html"),
        ]
        if args.mode == "deployment":
            report_command.extend(("--artifact", str(artifact_dir)))
        # The report reads run.json while it renders. Mark the analytical
        # pipeline complete, render once as a recorded stage, then refresh the
        # snapshot so the final HTML also sees the report stage as completed.
        manifest["status"] = "completed"
        manifest["finished_at"] = utc_now()
        manifest["report"] = str(report_dir / "index.html")
        write_manifest(manifest_path, manifest)
        run_stage(
            "Render standalone HTML audit report",
            report_command,
            logs_dir / "06-report.log",
            manifest,
            manifest_path,
        )
        run_stage(
            "Refresh completed report snapshot",
            report_command,
            logs_dir / "06-report-final.log",
            manifest,
            manifest_path,
            record_in_manifest=False,
        )
    except BaseException as error:
        manifest["status"] = (
            "interrupted" if isinstance(error, KeyboardInterrupt) else "failed"
        )
        manifest["finished_at"] = utc_now()
        manifest["error"] = str(error)
        write_manifest(manifest_path, manifest)
        raise

    manifest["status"] = "completed"
    manifest["finished_at"] = utc_now()
    manifest["report_rendered_at"] = manifest["finished_at"]
    manifest["report"] = str(report_dir / "index.html")
    manifest.pop("error", None)
    write_manifest(manifest_path, manifest)
    print(f"\nCompleted. Open: {report_dir / 'index.html'}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
