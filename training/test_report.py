"""Tests for the standalone SponsorLens HTML training report."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from report import (
    discover_evaluations,
    generate_report,
    main,
    parse_evaluation_spec,
)


LABELS = ("irrelevant", "no", "conditional", "yes", "review")


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def evaluation_metrics(split: str) -> dict[str, object]:
    per_class = {
        label: {
            "precision": 0.9,
            "recall": 0.8,
            "f1": 0.847,
            "support": 4,
        }
        for label in LABELS
    }
    accepted_classes = {
        label: {"accepted": 3, "precision": 1.0}
        for label in LABELS
    }
    return {
        "split": split,
        "runtime": "onnxruntime-cpu",
        "deployment_sha256": "deployment-test",
        "max_length": 192,
        "verified_only": True,
        "examples": 20,
        "accuracy": 0.9,
        "macro_f1": 0.847,
        "expected_calibration_error": 0.025,
        "multiclass_brier_score": 0.08,
        "inference": {
            "seconds": 0.2,
            "milliseconds_per_example": 10.0,
            "examples_per_second": 100.0,
            "model_bytes": 1024 * 1024,
        },
        "per_class": per_class,
        "confusion_matrix": [
            [4 if row == column else 0 for column in range(len(LABELS))]
            for row in range(len(LABELS))
        ],
        "accepted_decisions": {
            "coverage": 0.75,
            "accuracy": 1.0,
            "accepted": 15,
            "total": 20,
            "per_class": accepted_classes,
        },
        "threshold_tradeoffs": {
            label: [
                {
                    "threshold": 0.99,
                    "accepted": 1,
                    "precision": 1.0,
                    "coverage": 0.05,
                },
                {
                    "threshold": 0.95,
                    "accepted": 3,
                    "precision": 1.0,
                    "coverage": 0.15,
                },
            ]
            for label in LABELS
        },
        "mistake_count": 1,
        "error_examples": [
            {
                "id": "dangerous-example",
                "truth": "no",
                "predicted": "yes",
                "confidence": 0.99,
                "accepted": True,
                "text": "<script>alert('offline report')</script>",
                "evidence": {"text": "will not sponsor"},
            }
        ],
    }


class OfflineReportTest(unittest.TestCase):
    def test_run_experiment_cli_builds_one_offline_html_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data_path = root / "jobs.jsonl"
            examples = [
                {
                    "id": "one",
                    "group_id": "group-one",
                    "text": "Visa sponsorship is unavailable.",
                    "label": "no",
                    "source": "curated",
                    "verified": True,
                    "split": "train",
                },
                {
                    "id": "two",
                    "group_id": "group-two",
                    "text": "Visa sponsorship is available.",
                    "label": "yes",
                    "source": "curated",
                    "verified": True,
                    "split": "validation",
                },
            ]
            data_path.write_text(
                "".join(json.dumps(example) + "\n" for example in examples),
                encoding="utf-8",
            )

            run_path = root / "run.json"
            write_json(
                run_path,
                {
                    "run_name": "audit-<one>",
                    "status": "running",
                    "mode": "deployment",
                    "started_at": "2026-08-04T00:00:00+00:00",
                    "research_only": True,
                    "data": str(data_path),
                    "data_sha256": "dataset-test",
                    "available_splits": ["train", "validation", "test"],
                    "configuration": {"epochs": 2, "seed": 17},
                    "stages": [
                        {
                            "name": "Train",
                            "status": "completed",
                            "duration_seconds": 1.25,
                            "command": ["python3", "train.py", "<unsafe>"],
                        }
                    ],
                },
            )

            training = root / "checkpoint"
            write_json(
                training / "training_metadata.json",
                {
                    "base_model": "tiny-test-model",
                    "max_length": 192,
                },
            )
            write_json(
                training / "checkpoint-10" / "trainer_state.json",
                {
                    "global_step": 10,
                    "best_metric": 0.7,
                    "log_history": [{"step": 10, "loss": 0.8}],
                },
            )
            write_json(
                training / "checkpoint-20" / "trainer_state.json",
                {
                    "global_step": 20,
                    "best_metric": 0.847,
                    "log_history": [
                        {"step": 10, "loss": 0.8, "learning_rate": 0.00003},
                        {
                            "step": 20,
                            "eval_loss": 0.3,
                            "eval_macro_f1": 0.847,
                            "eval_accuracy": 0.9,
                        },
                    ],
                },
            )
            history_rows = [
                {
                    "schema_version": 1,
                    "event": "train_begin",
                    "step": 0,
                    "max_steps": 30,
                    "epoch": 0,
                },
                {
                    "schema_version": 1,
                    "event": "step",
                    "step": 30,
                    "max_steps": 30,
                    "epoch": 2,
                    "metrics": {"loss": 0.123, "learning_rate": 0.00001},
                },
                {
                    "schema_version": 1,
                    "event": "evaluation",
                    "step": 30,
                    "max_steps": 30,
                    "epoch": 2,
                    "metrics": {"eval_loss": 0.2, "eval_macro_f1": 0.91},
                },
            ]
            (training / "training_history.jsonl").write_text(
                "".join(json.dumps(row) + "\n" for row in history_rows),
                encoding="utf-8",
            )

            evaluations = root / "evaluations"
            thresholds = {
                "runtime": "onnxruntime-cpu",
                "deployment_sha256": "deployment-test",
                "selected_on": "validation",
                "verified_only": True,
                "target_precision": 0.97,
                "minimum_predictions": 10,
                "thresholds": {label: 0.95 for label in LABELS},
            }
            for split in ("validation", "test"):
                write_json(
                    evaluations / split / "metrics.json",
                    evaluation_metrics(split),
                )
                write_json(evaluations / split / "thresholds.json", thresholds)

            artifact = root / "artifact"
            (artifact / "onnx").mkdir(parents=True)
            (artifact / "onnx" / "model_quantized.onnx").write_bytes(b"model")
            write_json(
                artifact / "artifact.json",
                {
                    "version": "audit-v1",
                    "task": "text-classification",
                    "labels": list(LABELS),
                    "max_length": 192,
                    "quantization": "dynamic-int8",
                    "deployment_sha256": "deployment-test",
                    "files": {
                        "onnx/model_quantized.onnx": "model-sha256",
                    },
                    "thresholds": {label: 0.95 for label in LABELS},
                    "calibration": {
                        "runtime": "onnxruntime-cpu",
                        "selected_on": "validation",
                        "verified_only": True,
                        "target_precision": 0.97,
                        "minimum_predictions": 10,
                    },
                    "release_ready": False,
                },
            )

            output = root / "report" / "index.html"
            result = main(
                [
                    "--data",
                    str(data_path),
                    "--run",
                    str(run_path),
                    "--training",
                    str(training),
                    "--evaluations",
                    str(evaluations),
                    "--artifact",
                    str(artifact),
                    "--output",
                    str(output),
                ]
            )

            self.assertEqual(result, 0)
            rendered = output.read_text(encoding="utf-8")
            self.assertTrue(rendered.startswith("<!doctype html>"))
            self.assertIn("SponsorLens · audit-&lt;one&gt;", rendered)
            self.assertIn("tiny-test-model", rendered)
            self.assertIn("Global step", rendered)
            self.assertIn(">30<", rendered)
            self.assertIn("training_history.jsonl", rendered)
            self.assertIn("loss=0.12300", rendered)
            self.assertIn("Evaluation: validation", rendered)
            self.assertIn("Evaluation: test", rendered)
            self.assertIn("audit-v1", rendered)
            self.assertIn("Threshold precision vs coverage", rendered)
            self.assertIn("&lt;script&gt;alert", rendered)
            self.assertNotIn("<script", rendered.lower())
            self.assertNotIn("https://", rendered.lower())
            self.assertNotIn("http://", rendered.lower())
            self.assertNotIn("src=", rendered.lower())

    def test_missing_optional_trainer_files_become_report_notes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            trainer = Path(temporary) / "empty-training"
            trainer.mkdir()
            rendered = generate_report(trainer_path=trainer)

            self.assertIn("No training_metadata.json found", rendered)
            self.assertIn("No trainer_state.json found", rendered)
            self.assertIn("No evaluation reports supplied", rendered)

    def test_evaluation_discovery_and_named_spec(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_json(root / "test" / "metrics.json", {"split": "test"})
            write_json(
                root / "validation" / "metrics.json",
                {"split": "validation"},
            )

            discovered = discover_evaluations(root)
            self.assertEqual(
                [name for name, _ in discovered],
                ["test", "validation"],
            )
            name, path = parse_evaluation_spec(f"held-out={root / 'test'}")
            self.assertEqual(name, "held-out")
            self.assertEqual(path, root / "test")


if __name__ == "__main__":
    unittest.main()
