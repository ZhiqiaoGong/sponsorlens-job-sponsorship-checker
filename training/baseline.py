#!/usr/bin/env python3
"""Small TF-IDF baseline used only to verify the data and metrics pipeline."""

from __future__ import annotations

import argparse
from pathlib import Path

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.pipeline import FeatureUnion, Pipeline

from data_utils import (
    LABELS,
    load_jsonl,
    select_split,
    validate_runtime_gate,
    with_assigned_splits,
)
from validate_data import validate_dataset


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("data", type=Path)
    parser.add_argument("--split", choices=("validation", "test"), default="test")
    parser.add_argument("--include-unverified", action="store_true")
    args = parser.parse_args()

    try:
        validate_runtime_gate(args.data)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    examples, errors, warnings = validate_dataset(load_jsonl(args.data))
    for warning in warnings:
        print(f"warning: {warning}")
    if errors:
        raise SystemExit("\n".join(errors))
    examples = with_assigned_splits(examples)
    if not args.include_unverified:
        examples = [example for example in examples if example["verified"]]
    train = select_split(examples, "train")
    evaluation = select_split(examples, args.split)
    if not train or not evaluation:
        raise SystemExit("both train and evaluation splits must contain examples")

    pipeline = Pipeline(
        [
            (
                "features",
                FeatureUnion(
                    [
                        (
                            "word",
                            TfidfVectorizer(
                                lowercase=True,
                                ngram_range=(1, 2),
                                min_df=1,
                                sublinear_tf=True,
                            ),
                        ),
                        (
                            "character",
                            TfidfVectorizer(
                                analyzer="char_wb",
                                lowercase=True,
                                ngram_range=(3, 5),
                                min_df=1,
                                sublinear_tf=True,
                            ),
                        ),
                    ]
                ),
            ),
            (
                "classifier",
                LogisticRegression(
                    class_weight="balanced",
                    max_iter=2000,
                    random_state=17,
                ),
            ),
        ]
    )
    pipeline.fit(
        [example["text"] for example in train],
        [example["label"] for example in train],
    )
    truth = [example["label"] for example in evaluation]
    predicted = pipeline.predict([example["text"] for example in evaluation])

    print(
        classification_report(
            truth,
            predicted,
            labels=list(LABELS),
            digits=3,
            zero_division=0,
        )
    )
    print("labels:", " ".join(LABELS))
    print(confusion_matrix(truth, predicted, labels=list(LABELS)))
    print(
        "\nThis baseline is a pipeline smoke test, not a production accuracy "
        "measurement. The checked-in seed set is synthetic and very small."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
