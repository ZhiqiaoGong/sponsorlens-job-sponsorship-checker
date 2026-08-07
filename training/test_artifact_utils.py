"""Regression tests for local-model package integrity checks."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from artifact_utils import (
    build_file_manifest,
    deployment_sha256,
    validate_artifact_directory,
    validate_thresholds,
)
from data_utils import LABEL2ID, LABELS


class ArtifactIntegrityTest(unittest.TestCase):
    def make_artifact(self, directory: Path) -> Path:
        (directory / "onnx").mkdir(parents=True)
        (directory / "onnx" / "model_quantized.onnx").write_bytes(b"onnx-test")
        (directory / "tokenizer.json").write_text("{}\n", encoding="utf-8")
        (directory / "config.json").write_text(
            json.dumps(
                {
                    "label2id": LABEL2ID,
                    "id2label": {
                        str(index): label
                        for index, label in enumerate(LABELS)
                    },
                }
            ) + "\n",
            encoding="utf-8",
        )
        files = build_file_manifest(
            directory,
            (
                "config.json",
                "tokenizer.json",
                "onnx/model_quantized.onnx",
            ),
        )
        package_hash = deployment_sha256("test-v1", list(LABELS), 192, files)
        (directory / "artifact.json").write_text(
            json.dumps(
                {
                    "version": "test-v1",
                    "labels": list(LABELS),
                    "max_length": 192,
                    "files": files,
                    "deployment_sha256": package_hash,
                }
            ) + "\n",
            encoding="utf-8",
        )
        return directory / "onnx" / "model_quantized.onnx"

    def test_manifest_binds_model_tokenizer_labels_and_length(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            onnx_path = self.make_artifact(directory)
            artifact = validate_artifact_directory(directory, onnx_path)
            self.assertEqual(artifact["max_length"], 192)

            (directory / "tokenizer.json").write_text(
                '{"changed":true}\n', encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                validate_artifact_directory(directory, onnx_path)

    def test_thresholds_must_be_null_or_between_zero_and_one(self) -> None:
        valid = {label: None for label in LABELS}
        valid["no"] = 0.97
        self.assertEqual(validate_thresholds(valid, LABELS)["no"], 0.97)

        for invalid in (-0.01, 1.01, True, "0.97"):
            values = dict(valid)
            values["no"] = invalid
            with self.assertRaises(ValueError):
                validate_thresholds(values, LABELS)


if __name__ == "__main__":
    unittest.main()
