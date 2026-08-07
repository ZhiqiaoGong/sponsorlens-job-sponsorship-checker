#!/usr/bin/env python3
"""Fine-tune a compact encoder for SponsorLens window classification."""

from __future__ import annotations

import argparse
import inspect
import json
import math
import os
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import numpy as np
import torch
from sklearn.metrics import precision_recall_fscore_support
from torch.utils.data import Dataset
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    DataCollatorWithPadding,
    EvalPrediction,
    PrinterCallback,
    Trainer,
    TrainerCallback,
    TrainingArguments,
    __version__ as transformers_version,
    set_seed,
)

from data_utils import (
    ID2LABEL,
    LABEL2ID,
    LABELS,
    load_jsonl,
    select_split,
    validate_runtime_gate,
)
from validate_data import summarize, validate_dataset


DEFAULT_MODEL = "google/bert_uncased_L-4_H-256_A-4"
HISTORY_SCHEMA_VERSION = 1


def _utc_timestamp() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _json_safe(value: Any) -> Any:
    """Convert metric values to strict JSON without silently emitting NaN."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "item"):
        try:
            return _json_safe(value.item())
        except (TypeError, ValueError):
            pass
    return str(value)


class JsonlHistory:
    """Append-only, crash-resistant JSONL storage for one training run."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def reset(self, record: Mapping[str, Any]) -> None:
        self._write(record, mode="w")

    def append(self, record: Mapping[str, Any]) -> None:
        self._write(record, mode="a")

    def _write(self, record: Mapping[str, Any], mode: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": HISTORY_SCHEMA_VERSION,
            "timestamp": _utc_timestamp(),
            **dict(record),
        }
        serialized = json.dumps(
            _json_safe(payload),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        with self.path.open(mode, encoding="utf-8") as handle:
            handle.write(serialized + "\n")
            handle.flush()
            os.fsync(handle.fileno())


class TrainingHistoryCallback(TrainerCallback):
    """Persist Trainer events and print a compact, deterministic progress view."""

    def __init__(
        self,
        history_path: Path,
        run_metadata: Mapping[str, Any] | None = None,
        progress_steps: int = 10,
        emit_progress: bool = True,
    ) -> None:
        if progress_steps < 1:
            raise ValueError("progress_steps must be at least 1")
        self.history = JsonlHistory(history_path)
        self.run_metadata = dict(run_metadata or {})
        self.progress_steps = progress_steps
        self.emit_progress = emit_progress
        self._printed_step = False
        self._last_progress_bucket = 0

    @staticmethod
    def _is_primary(state: Any) -> bool:
        return bool(getattr(state, "is_world_process_zero", True))

    @staticmethod
    def _number(value: Any) -> float | None:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        return number if math.isfinite(number) else None

    def _record(
        self,
        event: str,
        args: Any,
        state: Any,
        metrics: Mapping[str, Any] | None = None,
        reset: bool = False,
    ) -> None:
        step = int(getattr(state, "global_step", 0) or 0)
        max_steps = int(getattr(state, "max_steps", 0) or 0)
        epoch = self._number(getattr(state, "epoch", None))
        total_epochs = self._number(getattr(args, "num_train_epochs", None))
        record: dict[str, Any] = {
            "event": event,
            "step": step,
            "max_steps": max_steps,
            "progress": (step / max_steps) if max_steps > 0 else None,
            "epoch": epoch,
            "total_epochs": total_epochs,
        }
        if metrics:
            record["metrics"] = dict(metrics)
        if reset:
            record["run"] = self.run_metadata
            self.history.reset(record)
        else:
            self.history.append(record)

    def _print(self, message: str) -> None:
        if self.emit_progress:
            print(message, flush=True)

    @staticmethod
    def _format_metric(metrics: Mapping[str, Any], *names: str) -> str | None:
        for name in names:
            value = metrics.get(name)
            try:
                number = float(value)
            except (TypeError, ValueError):
                continue
            if math.isfinite(number):
                return f"{number:.4f}"
        return None

    @staticmethod
    def _format_learning_rate(metrics: Mapping[str, Any]) -> str | None:
        try:
            number = float(metrics.get("learning_rate"))
        except (TypeError, ValueError):
            return None
        return f"{number:.3e}" if math.isfinite(number) else None

    def on_train_begin(
        self,
        args: Any,
        state: Any,
        control: Any,
        **kwargs: Any,
    ) -> None:
        if not self._is_primary(state):
            return
        self._printed_step = False
        self._last_progress_bucket = 0
        self._record("train_begin", args, state, reset=True)
        max_steps = int(getattr(state, "max_steps", 0) or 0)
        total_epochs = self._number(getattr(args, "num_train_epochs", None))
        epoch_text = f"{total_epochs:g}" if total_epochs is not None else "?"
        step_text = str(max_steps) if max_steps > 0 else "?"
        self._print(
            f"[train] starting {step_text} steps across {epoch_text} epochs; "
            f"history: {self.history.path}"
        )

    def on_log(
        self,
        args: Any,
        state: Any,
        control: Any,
        logs: Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        if not self._is_primary(state) or not logs:
            return
        metrics = dict(logs)
        if any(key.startswith("eval_") for key in metrics):
            event = "evaluation"
        elif any(key.startswith("train_") for key in metrics):
            event = "train_metrics"
        elif "loss" in metrics or "learning_rate" in metrics:
            event = "step"
        else:
            event = "log"
        self._record(event, args, state, metrics=metrics)

        step = int(getattr(state, "global_step", 0) or 0)
        max_steps = int(getattr(state, "max_steps", 0) or 0)
        epoch = self._number(getattr(state, "epoch", None))
        total_epochs = self._number(getattr(args, "num_train_epochs", None))
        epoch_text = (
            f"{epoch:.2f}/{total_epochs:g}"
            if epoch is not None and total_epochs is not None
            else "?"
        )

        if event == "step":
            progress_bucket = step // self.progress_steps
            should_print = (
                not self._printed_step
                or progress_bucket > self._last_progress_bucket
                or (max_steps > 0 and step >= max_steps)
            )
            if not should_print:
                return
            self._printed_step = True
            self._last_progress_bucket = progress_bucket
            progress = f"{100 * step / max_steps:.1f}%" if max_steps > 0 else "?"
            details = []
            loss = self._format_metric(metrics, "loss")
            learning_rate = self._format_learning_rate(metrics)
            if loss is not None:
                details.append(f"loss={loss}")
            if learning_rate is not None:
                details.append(f"lr={learning_rate}")
            suffix = f" {' '.join(details)}" if details else ""
            self._print(
                f"[train] step {step}/{max_steps or '?'} ({progress}) "
                f"epoch {epoch_text}{suffix}"
            )
        elif event == "evaluation":
            details = []
            macro_f1 = self._format_metric(metrics, "eval_macro_f1", "macro_f1")
            loss = self._format_metric(metrics, "eval_loss")
            if macro_f1 is not None:
                details.append(f"macro_f1={macro_f1}")
            if loss is not None:
                details.append(f"loss={loss}")
            suffix = f" {' '.join(details)}" if details else ""
            self._print(
                f"[eval] epoch {epoch_text} step {step}/{max_steps or '?'}{suffix}"
            )

    def on_epoch_end(
        self,
        args: Any,
        state: Any,
        control: Any,
        **kwargs: Any,
    ) -> None:
        if not self._is_primary(state):
            return
        self._record("epoch_end", args, state)
        epoch = self._number(getattr(state, "epoch", None))
        total_epochs = self._number(getattr(args, "num_train_epochs", None))
        step = int(getattr(state, "global_step", 0) or 0)
        max_steps = int(getattr(state, "max_steps", 0) or 0)
        epoch_text = (
            f"{epoch:g}/{total_epochs:g}"
            if epoch is not None and total_epochs is not None
            else "?"
        )
        self._print(
            f"[epoch] {epoch_text} complete (step {step}/{max_steps or '?'})"
        )

    def on_save(
        self,
        args: Any,
        state: Any,
        control: Any,
        **kwargs: Any,
    ) -> None:
        if self._is_primary(state):
            self._record("checkpoint", args, state)

    def on_train_end(
        self,
        args: Any,
        state: Any,
        control: Any,
        **kwargs: Any,
    ) -> None:
        if not self._is_primary(state):
            return
        self._record("train_end", args, state)
        step = int(getattr(state, "global_step", 0) or 0)
        max_steps = int(getattr(state, "max_steps", 0) or 0)
        self._print(f"[train] complete at step {step}/{max_steps or '?'}")


def evaluation_strategy_parameter() -> str:
    parameters = inspect.signature(TrainingArguments.__init__).parameters
    if "eval_strategy" in parameters:
        return "eval_strategy"
    if "evaluation_strategy" in parameters:
        return "evaluation_strategy"
    raise RuntimeError(
        "installed transformers TrainingArguments has no evaluation strategy option"
    )


def trainer_tokenizer_parameter() -> str:
    parameters = inspect.signature(Trainer.__init__).parameters
    if "processing_class" in parameters:
        return "processing_class"
    if "tokenizer" in parameters:
        return "tokenizer"
    raise RuntimeError(
        "installed transformers Trainer has no tokenizer/processing_class option"
    )


class WindowDataset(Dataset):
    def __init__(
        self,
        examples: list[dict[str, Any]],
        tokenizer: Any,
        max_length: int,
    ) -> None:
        self.examples = examples
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.examples)

    def __getitem__(self, index: int) -> dict[str, Any]:
        example = self.examples[index]
        encoded = self.tokenizer(
            example["text"],
            truncation=True,
            max_length=self.max_length,
        )
        encoded["labels"] = LABEL2ID[example["label"]]
        return encoded


def compute_metrics(prediction: EvalPrediction) -> dict[str, float]:
    predicted = np.argmax(prediction.predictions, axis=-1)
    truth = prediction.label_ids
    precision, recall, f1, _ = precision_recall_fscore_support(
        truth,
        predicted,
        labels=list(range(len(LABELS))),
        zero_division=0,
    )
    metrics: dict[str, float] = {
        "accuracy": float(np.mean(predicted == truth)),
        "macro_f1": float(np.mean(f1)),
    }
    for index, label in enumerate(LABELS):
        metrics[f"{label}_precision"] = float(precision[index])
        metrics[f"{label}_recall"] = float(recall[index])
        metrics[f"{label}_f1"] = float(f1[index])
    return metrics


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-model", default=DEFAULT_MODEL)
    parser.add_argument(
        "--base-revision",
        help="Optional immutable Hugging Face commit/tag for reproducibility.",
    )
    parser.add_argument("--max-length", type=int, default=192)
    parser.add_argument("--epochs", type=float, default=5.0)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=3e-5)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument(
        "--logging-steps",
        type=int,
        default=1,
        help="Write loss and learning-rate history every N optimizer steps.",
    )
    parser.add_argument(
        "--progress-steps",
        type=int,
        default=10,
        help="Print a compact terminal update every N logged steps.",
    )
    parser.add_argument(
        "--history-file",
        type=Path,
        help="JSONL history path (default: OUTPUT/training_history.jsonl).",
    )
    parser.add_argument(
        "--include-unverified",
        action="store_true",
        help="Include examples whose verified field is false.",
    )
    args = parser.parse_args()
    if args.logging_steps < 1:
        parser.error("--logging-steps must be at least 1")
    if args.progress_steps < 1:
        parser.error("--progress-steps must be at least 1")
    if args.max_length < 1:
        parser.error("--max-length must be at least 1")
    if args.epochs <= 0 or not math.isfinite(args.epochs):
        parser.error("--epochs must be a finite number greater than zero")
    if args.batch_size < 1:
        parser.error("--batch-size must be at least 1")
    if args.learning_rate <= 0 or not math.isfinite(args.learning_rate):
        parser.error("--learning-rate must be a finite number greater than zero")
    history_path = args.history_file or args.output / "training_history.jsonl"
    if history_path.resolve() == args.data.resolve():
        parser.error("--history-file must not overwrite the training dataset")
    if args.history_file is not None and history_path.exists():
        parser.error("--history-file already exists; choose a new path")

    set_seed(args.seed)
    try:
        validate_runtime_gate(args.data)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    examples, errors, warnings = validate_dataset(load_jsonl(args.data))
    for warning in warnings:
        print(f"warning: {warning}")
    if errors:
        raise SystemExit("\n".join(errors))
    if not args.include_unverified:
        examples = [example for example in examples if example["verified"]]

    train_examples = select_split(examples, "train")
    validation_examples = select_split(examples, "validation")
    if not train_examples or not validation_examples:
        raise SystemExit("train and validation splits must both contain examples")
    missing_train_labels = sorted(
        set(LABELS) - {example["label"] for example in train_examples}
    )
    if missing_train_labels:
        raise SystemExit(
            "training split is missing labels: " + ", ".join(missing_train_labels)
        )

    pretrained_options = {"revision": args.base_revision} if args.base_revision else {}
    tokenizer = AutoTokenizer.from_pretrained(
        args.base_model,
        use_fast=True,
        **pretrained_options,
    )
    model = AutoModelForSequenceClassification.from_pretrained(
        args.base_model,
        num_labels=len(LABELS),
        id2label=ID2LABEL,
        label2id=LABEL2ID,
        ignore_mismatched_sizes=True,
        **pretrained_options,
    )
    train_dataset = WindowDataset(
        train_examples,
        tokenizer,
        max_length=args.max_length,
    )
    validation_dataset = WindowDataset(
        validation_examples,
        tokenizer,
        max_length=args.max_length,
    )

    training_argument_values = dict(
        output_dir=str(args.output),
        overwrite_output_dir=True,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size * 2,
        learning_rate=args.learning_rate,
        weight_decay=0.01,
        warmup_ratio=0.1,
        save_strategy="epoch",
        logging_strategy="steps",
        logging_steps=args.logging_steps,
        logging_first_step=True,
        load_best_model_at_end=True,
        metric_for_best_model="macro_f1",
        greater_is_better=True,
        save_total_limit=2,
        save_safetensors=True,
        report_to=[],
        seed=args.seed,
        data_seed=args.seed,
        fp16=False,
        disable_tqdm=True,
    )
    training_argument_values[evaluation_strategy_parameter()] = "epoch"
    training_args = TrainingArguments(**training_argument_values)

    history_callback = TrainingHistoryCallback(
        history_path=history_path,
        progress_steps=args.progress_steps,
        run_metadata={
            "base_model": args.base_model,
            "base_revision_requested": args.base_revision,
            "data": str(args.data),
            "output": str(args.output),
            "labels": list(LABELS),
            "seed": args.seed,
            "max_length": args.max_length,
            "batch_size": args.batch_size,
            "learning_rate": args.learning_rate,
            "logging_steps": args.logging_steps,
            "transformers_version": transformers_version,
        },
    )

    trainer_values = dict(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=validation_dataset,
        data_collator=DataCollatorWithPadding(tokenizer=tokenizer),
        compute_metrics=compute_metrics,
        callbacks=[history_callback],
    )
    trainer_values[trainer_tokenizer_parameter()] = tokenizer
    trainer = Trainer(
        **trainer_values,
    )
    # Our callback replaces the default raw-dictionary printer when tqdm is
    # disabled, keeping terminal output concise while JSONL retains all detail.
    trainer.remove_callback(PrinterCallback)
    trainer.train()
    final_metrics = trainer.evaluate()
    trainer.save_model(str(args.output))
    tokenizer.save_pretrained(str(args.output))

    metadata = {
        "base_model": args.base_model,
        "base_revision_requested": args.base_revision,
        "base_revision_resolved": getattr(model.config, "_commit_hash", None),
        "max_length": args.max_length,
        "seed": args.seed,
        "labels": list(LABELS),
        "data": str(args.data),
        "history_file": str(history_path),
        "logging_steps": args.logging_steps,
        "transformers_version": transformers_version,
        "environment": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "torch": torch.__version__,
            "numpy": np.__version__,
            "transformers": transformers_version,
        },
        "dataset_summary": summarize(examples),
        "validation_metrics": {
            key: float(value)
            for key, value in final_metrics.items()
            if isinstance(value, (int, float))
        },
        "release_ready": False,
        "release_note": (
            "Set only after independent company/template-disjoint evaluation "
            "meets the accepted precision target."
        ),
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "training_metadata.json").write_text(
        json.dumps(
            _json_safe(metadata),
            indent=2,
            sort_keys=True,
            allow_nan=False,
        ) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            _json_safe(metadata),
            indent=2,
            sort_keys=True,
            allow_nan=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
