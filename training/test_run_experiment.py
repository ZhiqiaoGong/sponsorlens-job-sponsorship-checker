"""Tests for experiment configuration safeguards."""

from __future__ import annotations

import unittest

from run_experiment import SEED_DATA, parse_args, resolve_args


class RunExperimentTest(unittest.TestCase):
    def test_seed_requires_explicit_smoke_mode(self) -> None:
        with self.assertRaisesRegex(ValueError, "--smoke"):
            resolve_args(parse_args(["--data", str(SEED_DATA)]))

    def test_smoke_uses_safe_short_defaults(self) -> None:
        args = resolve_args(parse_args(["--smoke", "--run-name", "test-smoke"]))
        self.assertEqual(args.data, SEED_DATA.resolve())
        self.assertEqual(args.epochs, 1.0)
        self.assertEqual(args.minimum_predictions, 2)

    def test_run_name_cannot_escape_output_directory(self) -> None:
        with self.assertRaisesRegex(ValueError, "single directory"):
            resolve_args(parse_args(["--smoke", "--run-name", "../escape"]))

    def test_deployment_rejects_unverified_calibration(self) -> None:
        with self.assertRaisesRegex(ValueError, "verified-only"):
            resolve_args(
                parse_args(
                    [
                        "--smoke",
                        "--mode",
                        "deployment",
                        "--include-unverified",
                    ]
                )
            )

    def test_invalid_training_dimensions_fail_before_run(self) -> None:
        for option, value in (
            ("--batch-size", "0"),
            ("--max-length", "0"),
            ("--learning-rate", "0"),
        ):
            with self.subTest(option=option):
                with self.assertRaises(ValueError):
                    resolve_args(parse_args(["--smoke", option, value]))


if __name__ == "__main__":
    unittest.main()
