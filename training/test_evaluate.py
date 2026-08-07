"""Unit tests for transparent evaluation output."""

from __future__ import annotations

import unittest
import tempfile
from pathlib import Path

import numpy as np

from data_utils import LABEL2ID, LABELS
from evaluate import (
    accepted_mask,
    error_examples,
    select_thresholds,
    research_checkpoint_sha256,
    threshold_tradeoffs,
)


class EvaluationReportingTest(unittest.TestCase):
    def test_null_threshold_always_abstains(self) -> None:
        probabilities = np.asarray([[0.0, 1.0, 0.0, 0.0, 0.0]])
        thresholds = {label: None for label in LABELS}
        self.assertEqual(accepted_mask(probabilities, thresholds).tolist(), [False])

    def test_tradeoffs_report_precision_and_coverage(self) -> None:
        probabilities = np.asarray(
            [
                [0.02, 0.90, 0.03, 0.03, 0.02],
                [0.02, 0.80, 0.03, 0.12, 0.03],
                [0.90, 0.02, 0.02, 0.03, 0.03],
            ]
        )
        truth = np.asarray(
            [LABEL2ID["no"], LABEL2ID["yes"], LABEL2ID["irrelevant"]]
        )
        points = threshold_tradeoffs(probabilities, truth)["no"]
        self.assertEqual(points[0]["accepted"], 1)
        self.assertEqual(points[0]["precision"], 1.0)
        self.assertEqual(points[-1]["accepted"], 2)
        self.assertEqual(points[-1]["precision"], 0.5)

    def test_errors_include_exact_text_and_acceptance(self) -> None:
        probabilities = np.asarray([[0.01, 0.95, 0.01, 0.02, 0.01]])
        truth = np.asarray([LABEL2ID["yes"]])
        selected = [
            {
                "id": "job-1",
                "group_id": "company-1",
                "source": "test",
                "text": "We sponsor qualified candidates.",
                "evidence": {"start": 3, "end": 10, "text": "sponsor"},
            }
        ]
        thresholds = {label: None for label in LABELS}
        thresholds["no"] = 0.90
        rows, count = error_examples(
            selected,
            probabilities,
            truth,
            thresholds,
        )
        self.assertEqual(count, 1)
        self.assertEqual(rows[0]["text"], selected[0]["text"])
        self.assertEqual(rows[0]["truth"], "yes")
        self.assertEqual(rows[0]["predicted"], "no")
        self.assertTrue(rows[0]["accepted"])

    def test_threshold_selection_accounts_for_boundary_ties(self) -> None:
        probabilities = np.asarray(
            [
                [0.01, 0.95, 0.01, 0.02, 0.01],
                [0.01, 0.95, 0.01, 0.02, 0.01],
            ]
        )
        truth = np.asarray([LABEL2ID["no"], LABEL2ID["yes"]])
        thresholds = select_thresholds(
            probabilities,
            truth,
            target_precision=0.90,
            minimum_predictions=1,
        )
        self.assertIsNone(thresholds["no"])

    def test_threshold_serialization_does_not_round_below_boundary(self) -> None:
        probabilities = np.asarray(
            [
                [0.01, 0.9000004, 0.01, 0.0399996, 0.04],
                [0.01, 0.9000002, 0.01, 0.0399998, 0.04],
            ]
        )
        truth = np.asarray([LABEL2ID["no"], LABEL2ID["yes"]])
        thresholds = select_thresholds(
            probabilities,
            truth,
            target_precision=0.90,
            minimum_predictions=1,
        )
        self.assertEqual(thresholds["no"], 0.9000004)
        accepted = accepted_mask(probabilities, thresholds)
        self.assertEqual(accepted.tolist(), [True, False])

    def test_research_checkpoint_hash_binds_weights_and_length(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            checkpoint = Path(temporary)
            (checkpoint / "config.json").write_text("{}\n", encoding="utf-8")
            (checkpoint / "tokenizer.json").write_text("{}\n", encoding="utf-8")
            weights = checkpoint / "model.safetensors"
            weights.write_bytes(b"weights-one")
            original = research_checkpoint_sha256(checkpoint, 192)
            self.assertNotEqual(original, research_checkpoint_sha256(checkpoint, 256))
            weights.write_bytes(b"weights-two")
            self.assertNotEqual(original, research_checkpoint_sha256(checkpoint, 192))


if __name__ == "__main__":
    unittest.main()
