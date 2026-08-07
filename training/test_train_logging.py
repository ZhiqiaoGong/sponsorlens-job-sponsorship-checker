"""Regression tests for structured training history and progress output."""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from train import (
    TrainingHistoryCallback,
    evaluation_strategy_parameter,
    trainer_tokenizer_parameter,
)


class TrainingHistoryCallbackTest(unittest.TestCase):
    def test_writes_strict_jsonl_for_steps_epochs_and_evaluation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            history_path = Path(temporary) / "history.jsonl"
            callback = TrainingHistoryCallback(
                history_path,
                run_metadata={"base_model": "test-model"},
                progress_steps=10,
                emit_progress=False,
            )
            args = SimpleNamespace(num_train_epochs=2.0)
            state = SimpleNamespace(
                is_world_process_zero=True,
                global_step=0,
                max_steps=10,
                epoch=0.0,
            )

            callback.on_train_begin(args, state, None)
            state.global_step = 1
            state.epoch = 0.2
            callback.on_log(
                args,
                state,
                None,
                logs={
                    "loss": np.float32(0.75),
                    "learning_rate": 3e-5,
                    "unstable_metric": float("nan"),
                },
            )
            state.global_step = 5
            state.epoch = 1.0
            callback.on_epoch_end(args, state, None)
            callback.on_log(
                args,
                state,
                None,
                logs={"eval_loss": 0.5, "eval_macro_f1": 0.8},
            )
            callback.on_train_end(args, state, None)

            records = [
                json.loads(line)
                for line in history_path.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(
                [record["event"] for record in records],
                [
                    "train_begin",
                    "step",
                    "epoch_end",
                    "evaluation",
                    "train_end",
                ],
            )
            self.assertEqual(records[0]["run"]["base_model"], "test-model")
            self.assertEqual(records[1]["metrics"]["loss"], 0.75)
            self.assertIsNone(records[1]["metrics"]["unstable_metric"])
            self.assertAlmostEqual(records[1]["progress"], 0.1)
            self.assertTrue(
                all(record["schema_version"] == 1 for record in records)
            )

    def test_only_primary_process_writes_and_progress_is_throttled(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            history_path = Path(temporary) / "history.jsonl"
            callback = TrainingHistoryCallback(
                history_path,
                progress_steps=10,
                emit_progress=True,
            )
            args = SimpleNamespace(num_train_epochs=2.0)
            state = SimpleNamespace(
                is_world_process_zero=False,
                global_step=0,
                max_steps=20,
                epoch=0.0,
            )
            callback.on_train_begin(args, state, None)
            self.assertFalse(history_path.exists())

            state.is_world_process_zero = True
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                callback.on_train_begin(args, state, None)
                state.global_step = 1
                state.epoch = 0.1
                callback.on_log(args, state, None, logs={"loss": 1.0})
                state.global_step = 2
                state.epoch = 0.2
                callback.on_log(args, state, None, logs={"loss": 0.9})
                state.global_step = 10
                state.epoch = 1.0
                callback.on_log(args, state, None, logs={"loss": 0.5})

            progress = output.getvalue()
            self.assertIn("[train] starting 20 steps", progress)
            self.assertIn("step 1/20", progress)
            self.assertNotIn("step 2/20", progress)
            self.assertIn("step 10/20", progress)

    def test_transformers_compatibility_parameter_detection(self) -> None:
        self.assertIn(
            evaluation_strategy_parameter(),
            {"eval_strategy", "evaluation_strategy"},
        )
        self.assertIn(
            trainer_tokenizer_parameter(),
            {"processing_class", "tokenizer"},
        )


if __name__ == "__main__":
    unittest.main()
