#!/usr/bin/env python3
"""Generate a self-contained offline HTML report for SponsorLens training runs.

The report deliberately uses only the Python standard library and embeds all
styles and SVG charts. It never loads a CDN, font, script, image, or stylesheet.
"""

from __future__ import annotations

import argparse
import html
import json
import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence


DEFAULT_LABELS = ("irrelevant", "no", "conditional", "yes", "review")
DEFAULT_SPLITS = ("train", "validation", "test", "challenge")


class ReportError(ValueError):
    """Raised when an explicitly requested report input cannot be read."""


@dataclass(frozen=True)
class EvaluationBundle:
    name: str
    path: Path
    metrics: dict[str, Any]
    thresholds: dict[str, Any]


def _escape(value: Any) -> str:
    return html.escape(str(value), quote=True)


def _is_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _number(value: Any, digits: int = 3, fallback: str = "Not available") -> str:
    if not _is_number(value):
        return fallback
    return f"{float(value):.{digits}f}"


def _percent(value: Any, digits: int = 1, fallback: str = "Not available") -> str:
    if not _is_number(value):
        return fallback
    return f"{float(value) * 100:.{digits}f}%"


def _bytes(value: Any) -> str:
    if not _is_number(value) or float(value) < 0:
        return "Not available"
    size = float(value)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            digits = 0 if unit == "B" else 1
            return f"{size:.{digits}f} {unit}"
        size /= 1024
    return "Not available"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ReportError(f"missing JSON input: {path}") from error
    except (OSError, json.JSONDecodeError) as error:
        raise ReportError(f"cannot read JSON input {path}: {error}") from error
    if not isinstance(payload, dict):
        raise ReportError(f"expected a JSON object in {path}")
    return payload


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    examples: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise ReportError(f"cannot read dataset {path}: {error}") from error
    for line_number, raw_line in enumerate(lines, start=1):
        if not raw_line.strip():
            continue
        try:
            item = json.loads(raw_line)
        except json.JSONDecodeError as error:
            raise ReportError(
                f"invalid JSON in {path} on line {line_number}: {error.msg}"
            ) from error
        if not isinstance(item, dict):
            raise ReportError(
                f"expected an object in {path} on line {line_number}"
            )
        examples.append(item)
    return examples


def parse_evaluation_spec(value: str) -> tuple[str | None, Path]:
    """Parse either PATH or NAME=PATH without confusing an ordinary path."""
    if "=" in value:
        candidate_name, candidate_path = value.split("=", 1)
        if candidate_name.strip() and candidate_path.strip():
            return candidate_name.strip(), Path(candidate_path).expanduser()
    return None, Path(value).expanduser()


def discover_evaluations(root: Path) -> list[tuple[str | None, Path]]:
    """Discover evaluate.py output directories beneath an experiment root."""
    if not root.is_dir():
        raise ReportError(f"evaluations directory does not exist: {root}")
    discovered: list[tuple[str | None, Path]] = []
    if (root / "metrics.json").is_file():
        discovered.append((root.name or None, root))
    for metrics_path in sorted(root.glob("*/metrics.json")):
        discovered.append((metrics_path.parent.name, metrics_path.parent))
    if not discovered:
        raise ReportError(f"no metrics.json files found under {root}")
    return discovered


def _load_evaluation(name: str | None, source: Path) -> EvaluationBundle:
    if source.is_dir():
        metrics_path = source / "metrics.json"
        thresholds_path = source / "thresholds.json"
        display_path = source
    else:
        metrics_path = source
        thresholds_path = source.with_name("thresholds.json")
        display_path = source.parent
    metrics = _read_json(metrics_path)
    thresholds = _read_json(thresholds_path) if thresholds_path.exists() else {}
    inferred_name = (
        name
        or str(metrics.get("split") or "").strip()
        or display_path.name
        or "evaluation"
    )
    return EvaluationBundle(
        name=inferred_name,
        path=display_path,
        metrics=metrics,
        thresholds=thresholds,
    )


def _trainer_candidates(directory: Path) -> list[Path]:
    candidates: list[Path] = []
    direct = directory / "trainer_state.json"
    if direct.is_file():
        candidates.append(direct)
    candidates.extend(directory.glob("checkpoint-*/trainer_state.json"))
    return candidates


def _load_authoritative_history(path: Path) -> list[dict[str, Any]]:
    """Load train.py JSONL events and flatten each event.metrics object."""
    records = _read_jsonl(path)
    flattened: list[dict[str, Any]] = []
    for record in records:
        row = {key: value for key, value in record.items() if key != "metrics"}
        metrics = record.get("metrics")
        if isinstance(metrics, dict):
            row.update(metrics)
        flattened.append(row)
    return flattened


def _load_trainer(source: Path) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    warnings: list[str] = []
    state: dict[str, Any] = {}
    metadata: dict[str, Any] = {}
    if source.is_file():
        if source.name.endswith(".jsonl"):
            history = _load_authoritative_history(source)
            state = {
                "log_history": history,
                "global_step": max(
                    (
                        int(row.get("step") or 0)
                        for row in history
                        if _is_number(row.get("step"))
                    ),
                    default=0,
                ),
                "history_source": str(source),
            }
            return state, metadata, warnings
        payload = _read_json(source)
        if isinstance(payload.get("log_history"), list):
            state = payload
        else:
            metadata = payload
        return state, metadata, warnings

    if not source.is_dir():
        raise ReportError(f"trainer input does not exist: {source}")
    metadata_path = source / "training_metadata.json"
    if metadata_path.is_file():
        metadata = _read_json(metadata_path)
    else:
        warnings.append(f"No training_metadata.json found under {source}")

    candidates = _trainer_candidates(source)
    loaded: list[tuple[int, float, Path, dict[str, Any]]] = []
    for path in candidates:
        payload = _read_json(path)
        step = int(payload.get("global_step") or 0)
        loaded.append((step, path.stat().st_mtime, path, payload))
    if loaded:
        _, _, selected_path, state = max(loaded, key=lambda item: (item[0], item[1]))
        if selected_path.parent != source:
            warnings.append(f"Using latest Trainer state from {selected_path}")
    else:
        warnings.append(f"No trainer_state.json found under {source}")
    history_path = source / "training_history.jsonl"
    if history_path.is_file():
        history = _load_authoritative_history(history_path)
        state["log_history"] = history
        state["history_source"] = str(history_path)
        recorded_steps = [
            int(row.get("step") or 0)
            for row in history
            if _is_number(row.get("step"))
        ]
        if recorded_steps:
            state["global_step"] = max(recorded_steps)
        quality = [
            float(row["eval_macro_f1"])
            for row in history
            if _is_number(row.get("eval_macro_f1"))
        ]
        if quality and not _is_number(state.get("best_metric")):
            state["best_metric"] = max(quality)
    elif not state:
        warnings.append(f"No training_history.jsonl found under {source}")
    return state, metadata, warnings


def _dataset_summary(examples: Sequence[dict[str, Any]]) -> dict[str, Any]:
    by_split: dict[str, Counter[str]] = defaultdict(Counter)
    sources: Counter[str] = Counter()
    labels: list[str] = list(DEFAULT_LABELS)
    splits: list[str] = list(DEFAULT_SPLITS)
    groups: set[str] = set()
    verified = 0
    for example in examples:
        label = str(example.get("label") or "unknown")
        split = str(example.get("split") or "unassigned")
        if label not in labels:
            labels.append(label)
        if split not in splits:
            splits.append(split)
        by_split[split][label] += 1
        sources[str(example.get("source") or "unknown")] += 1
        if example.get("group_id") is not None:
            groups.add(str(example["group_id"]))
        verified += int(example.get("verified") is True)
    return {
        "examples": len(examples),
        "verified": verified,
        "groups": len(groups),
        "labels": labels,
        "splits": splits,
        "by_split": by_split,
        "sources": sources,
    }


def _metric_card(label: str, value: str, hint: str = "") -> str:
    return (
        '<div class="metric-card">'
        f'<div class="metric-label">{_escape(label)}</div>'
        f'<div class="metric-value">{_escape(value)}</div>'
        + (f'<div class="metric-hint">{_escape(hint)}</div>' if hint else "")
        + "</div>"
    )


def _status_pill(text: str, tone: str) -> str:
    safe_tone = tone if tone in {"pass", "warn", "fail", "info"} else "info"
    return f'<span class="status {safe_tone}">{_escape(text)}</span>'


def _bar(value: Any) -> str:
    numeric = min(1.0, max(0.0, float(value))) if _is_number(value) else 0.0
    return (
        '<div class="bar" aria-hidden="true">'
        f'<span style="width:{numeric * 100:.2f}%"></span></div>'
    )


def _render_dataset(summary: dict[str, Any], data_path: Path | None) -> str:
    if not summary:
        return '<section><h2>Dataset</h2><p class="empty">No dataset supplied.</p></section>'
    cards = "".join(
        (
            _metric_card("Examples", str(summary["examples"])),
            _metric_card(
                "Verified",
                str(summary["verified"]),
                _percent(
                    summary["verified"] / summary["examples"]
                    if summary["examples"]
                    else None
                ),
            ),
            _metric_card("Groups", str(summary["groups"])),
            _metric_card("Source", str(data_path) if data_path else "Not available"),
        )
    )
    header = "".join(f"<th>{_escape(label)}</th>" for label in summary["labels"])
    rows = []
    totals: Counter[str] = Counter()
    for split in summary["splits"]:
        counts = summary["by_split"].get(split, Counter())
        if not counts:
            continue
        totals.update(counts)
        cells = "".join(
            f'<td class="numeric">{int(counts.get(label, 0))}</td>'
            for label in summary["labels"]
        )
        rows.append(f"<tr><th>{_escape(split)}</th>{cells}</tr>")
    total_cells = "".join(
        f'<td class="numeric"><strong>{int(totals.get(label, 0))}</strong></td>'
        for label in summary["labels"]
    )
    source_rows = "".join(
        f"<tr><td>{_escape(source)}</td><td class=\"numeric\">{count}</td></tr>"
        for source, count in summary["sources"].most_common(10)
    )
    return f"""
    <section id="dataset">
      <h2>Dataset</h2>
      <div class="metrics">{cards}</div>
      <div class="two-column">
        <div>
          <h3>Label distribution</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>Split</th>{header}</tr></thead>
            <tbody>{''.join(rows)}<tr class="total"><th>Total</th>{total_cells}</tr></tbody>
          </table></div>
        </div>
        <div>
          <h3>Top sources</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>Source</th><th>Examples</th></tr></thead>
            <tbody>{source_rows or '<tr><td colspan="2">Not available</td></tr>'}</tbody>
          </table></div>
        </div>
      </div>
    </section>
    """


def _history_points(
    history: Sequence[dict[str, Any]], field: str
) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for index, row in enumerate(history):
        value = row.get(field)
        if not _is_number(value):
            continue
        step = row.get("step")
        x_value = float(step) if _is_number(step) else float(index)
        points.append((x_value, float(value)))
    return points


def _line_chart(title: str, series: Sequence[tuple[str, list[tuple[float, float]]]]) -> str:
    available = [(name, points) for name, points in series if points]
    if not available:
        return f'<div class="chart"><h3>{_escape(title)}</h3><p class="empty">No history available.</p></div>'
    width, height = 640, 230
    left, right, top, bottom = 48, 18, 20, 35
    all_points = [point for _, points in available for point in points]
    min_x = min(point[0] for point in all_points)
    max_x = max(point[0] for point in all_points)
    min_y = min(point[1] for point in all_points)
    max_y = max(point[1] for point in all_points)
    if math.isclose(min_x, max_x):
        max_x = min_x + 1
    if math.isclose(min_y, max_y):
        padding = max(0.05, abs(min_y) * 0.05)
        min_y -= padding
        max_y += padding
    y_padding = (max_y - min_y) * 0.08
    min_y -= y_padding
    max_y += y_padding

    def project(point: tuple[float, float]) -> tuple[float, float]:
        x = left + (point[0] - min_x) / (max_x - min_x) * (width - left - right)
        y = top + (max_y - point[1]) / (max_y - min_y) * (height - top - bottom)
        return x, y

    colors = ("#0f766e", "#2563eb", "#d97706", "#7c3aed")
    lines = []
    legend = []
    for index, (name, points) in enumerate(available):
        color = colors[index % len(colors)]
        coordinates = " ".join(
            f"{x:.1f},{y:.1f}" for x, y in map(project, points)
        )
        lines.append(
            f'<polyline points="{coordinates}" fill="none" stroke="{color}" '
            'stroke-width="3" stroke-linejoin="round" stroke-linecap="round" />'
        )
        legend.append(
            f'<span><i style="background:{color}"></i>{_escape(name)}</span>'
        )
    grid = []
    labels = []
    for tick in range(5):
        fraction = tick / 4
        y = top + fraction * (height - top - bottom)
        value = max_y - fraction * (max_y - min_y)
        grid.append(
            f'<line x1="{left}" y1="{y:.1f}" x2="{width-right}" y2="{y:.1f}" '
            'stroke="#dbe4ee" stroke-width="1" />'
        )
        labels.append(
            f'<text x="{left-8}" y="{y+4:.1f}" text-anchor="end">{value:.3f}</text>'
        )
    return f"""
      <div class="chart">
        <h3>{_escape(title)}</h3>
        <svg viewBox="0 0 {width} {height}" role="img" aria-label="{_escape(title)}">
          {''.join(grid)}
          <line x1="{left}" y1="{height-bottom}" x2="{width-right}" y2="{height-bottom}" stroke="#64748b" />
          {''.join(labels)}
          <text x="{left}" y="{height-9}">{min_x:.0f}</text>
          <text x="{width-right}" y="{height-9}" text-anchor="end">{max_x:.0f} steps</text>
          {''.join(lines)}
        </svg>
        <div class="legend">{''.join(legend)}</div>
      </div>
    """


def _render_training(state: dict[str, Any], metadata: dict[str, Any]) -> str:
    history = state.get("log_history") if isinstance(state.get("log_history"), list) else []
    loss_chart = _line_chart(
        "Loss",
        (
            ("Train loss", _history_points(history, "loss")),
            ("Validation loss", _history_points(history, "eval_loss")),
        ),
    )
    quality_chart = _line_chart(
        "Validation quality",
        (
            ("Macro F1", _history_points(history, "eval_macro_f1")),
            ("Accuracy", _history_points(history, "eval_accuracy")),
        ),
    )
    cards = "".join(
        (
            _metric_card("Base model", str(metadata.get("base_model", "Not available"))),
            _metric_card("Global step", str(state.get("global_step", "Not available"))),
            _metric_card("Best metric", _number(state.get("best_metric"))),
            _metric_card("Max tokens", str(metadata.get("max_length", "Not available"))),
            _metric_card("History source", str(state.get("history_source", "Trainer state"))),
        )
    )
    recent_rows = []
    for row in history[-20:]:
        metric_pairs = []
        for key in ("loss", "eval_loss", "eval_macro_f1", "eval_accuracy", "learning_rate"):
            if _is_number(row.get(key)):
                metric_pairs.append(f"{key}={_number(row[key], 5)}")
        if not metric_pairs:
            continue
        recent_rows.append(
            "<tr>"
            f"<td>{_escape(row.get('step', '—'))}</td>"
            f"<td>{_escape(_number(row.get('epoch'), 2, '—'))}</td>"
            f"<td><code>{_escape(', '.join(metric_pairs))}</code></td>"
            "</tr>"
        )
    return f"""
    <section id="training">
      <h2>Training</h2>
      <div class="metrics">{cards}</div>
      <div class="charts">{loss_chart}{quality_chart}</div>
      <details>
        <summary>Recent Trainer history ({len(history)} total records)</summary>
        <div class="table-wrap"><table>
          <thead><tr><th>Step</th><th>Epoch</th><th>Metrics</th></tr></thead>
          <tbody>{''.join(recent_rows) or '<tr><td colspan="3">No metric history available.</td></tr>'}</tbody>
        </table></div>
      </details>
    </section>
    """


def _labels_for_evaluation(metrics: dict[str, Any], thresholds: dict[str, Any]) -> list[str]:
    labels = list(DEFAULT_LABELS)
    for source in (
        metrics.get("per_class"),
        thresholds.get("thresholds"),
    ):
        if isinstance(source, dict):
            for label in source:
                if label not in labels:
                    labels.append(str(label))
    return labels


def _render_class_metrics(bundle: EvaluationBundle, labels: Sequence[str]) -> str:
    metrics = bundle.metrics
    per_class = metrics.get("per_class") if isinstance(metrics.get("per_class"), dict) else {}
    accepted = metrics.get("accepted_decisions") if isinstance(metrics.get("accepted_decisions"), dict) else {}
    accepted_classes = accepted.get("per_class") if isinstance(accepted.get("per_class"), dict) else {}
    threshold_values = bundle.thresholds.get("thresholds")
    if not isinstance(threshold_values, dict):
        threshold_values = {}
    rows = []
    for label in labels:
        values = per_class.get(label) if isinstance(per_class.get(label), dict) else {}
        accepted_values = (
            accepted_classes.get(label)
            if isinstance(accepted_classes.get(label), dict)
            else {}
        )
        threshold = threshold_values.get(label)
        threshold_text = "Abstain" if threshold is None else _number(threshold, 4)
        rows.append(
            f'<tr class="label-{_escape(label)}">'
            f"<th>{_escape(label)}</th>"
            f"<td>{_number(values.get('precision'))}{_bar(values.get('precision'))}</td>"
            f"<td>{_number(values.get('recall'))}{_bar(values.get('recall'))}</td>"
            f"<td>{_number(values.get('f1'))}{_bar(values.get('f1'))}</td>"
            f'<td class="numeric">{_escape(values.get("support", "—"))}</td>'
            f'<td class="numeric">{_escape(threshold_text)}</td>'
            f'<td class="numeric">{_escape(accepted_values.get("accepted", "—"))}</td>'
            f'<td class="numeric">{_escape(_number(accepted_values.get("precision"), 3, "—"))}</td>'
            "</tr>"
        )
    return f"""
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Class</th><th>Precision</th><th>Recall</th><th>F1</th>
          <th>Support</th><th>Threshold</th><th>Accepted</th><th>Accepted precision</th>
        </tr></thead>
        <tbody>{''.join(rows)}</tbody>
      </table></div>
    """


def _render_confusion(metrics: dict[str, Any], labels: Sequence[str]) -> str:
    matrix = metrics.get("confusion_matrix")
    if not isinstance(matrix, list) or len(matrix) != len(labels):
        return '<p class="empty">Confusion matrix not available.</p>'
    rows: list[list[Any]] = [row if isinstance(row, list) else [] for row in matrix]
    maximum = max(
        (float(value) for row in rows for value in row if _is_number(value)),
        default=0.0,
    )
    header = "".join(f"<th>{_escape(label)}</th>" for label in labels)
    rendered_rows = []
    for row_index, label in enumerate(labels):
        cells = []
        row = rows[row_index]
        for column_index in range(len(labels)):
            value = row[column_index] if column_index < len(row) else 0
            numeric = float(value) if _is_number(value) else 0.0
            alpha = 0.08 + (numeric / maximum * 0.72 if maximum else 0.0)
            cells.append(
                f'<td class="matrix-cell" style="background:rgba(15,118,110,{alpha:.3f})">'
                f"{_escape(value)}</td>"
            )
        rendered_rows.append(f"<tr><th>{_escape(label)}</th>{''.join(cells)}</tr>")
    return f"""
      <p class="axis-note">Rows are true labels; columns are predictions.</p>
      <div class="table-wrap"><table class="matrix">
        <thead><tr><th>True ↓ / Predicted →</th>{header}</tr></thead>
        <tbody>{''.join(rendered_rows)}</tbody>
      </table></div>
    """


def _render_threshold_tradeoffs(bundle: EvaluationBundle) -> str:
    tradeoffs = bundle.metrics.get("threshold_tradeoffs")
    if not isinstance(tradeoffs, dict):
        return ""
    focus_labels = ("no", "yes", "conditional")
    series: list[tuple[str, list[dict[str, Any]]]] = []
    for label in focus_labels:
        raw_points = tradeoffs.get(label)
        if not isinstance(raw_points, list):
            continue
        points = [
            point
            for point in raw_points
            if isinstance(point, dict)
            and _is_number(point.get("coverage"))
            and _is_number(point.get("precision"))
            and _is_number(point.get("threshold"))
        ]
        if points:
            points.sort(key=lambda point: float(point["coverage"]))
            series.append((label, points))
    if not series:
        return ""

    width, height = 700, 285
    left, right, top, bottom = 54, 20, 20, 43
    maximum_coverage = min(
        1.0,
        max(
            0.01,
            max(float(point["coverage"]) for _, points in series for point in points)
            * 1.05,
        ),
    )

    def project(point: dict[str, Any]) -> tuple[float, float]:
        coverage = min(maximum_coverage, max(0.0, float(point["coverage"])))
        precision = min(1.0, max(0.0, float(point["precision"])))
        x = left + coverage / maximum_coverage * (width - left - right)
        y = top + (1.0 - precision) * (height - top - bottom)
        return x, y

    colors = {"no": "#dc2626", "yes": "#15803d", "conditional": "#d97706"}
    threshold_values = bundle.thresholds.get("thresholds")
    if not isinstance(threshold_values, dict):
        threshold_values = {}
    shapes = []
    legend = []
    table_rows = []
    target_precision = bundle.thresholds.get("target_precision")
    for label, points in series:
        color = colors[label]
        coordinates = " ".join(
            f"{x:.1f},{y:.1f}" for x, y in map(project, points)
        )
        shapes.append(
            f'<polyline points="{coordinates}" fill="none" stroke="{color}" '
            'stroke-width="3" stroke-linejoin="round" stroke-linecap="round" />'
        )
        selected_threshold = threshold_values.get(label)
        selected_point = None
        if _is_number(selected_threshold):
            selected_point = min(
                points,
                key=lambda point: abs(
                    float(point["threshold"]) - float(selected_threshold)
                ),
            )
            marker_x, marker_y = project(selected_point)
            shapes.append(
                f'<circle cx="{marker_x:.1f}" cy="{marker_y:.1f}" r="5" '
                f'fill="white" stroke="{color}" stroke-width="3" />'
            )
        legend.append(
            f'<span><i style="background:{color}"></i>{_escape(label)}</span>'
        )
        qualified_coverages = [
            float(point["coverage"])
            for point in points
            if _is_number(target_precision)
            and float(point["precision"]) >= float(target_precision)
        ]
        table_rows.append(
            "<tr>"
            f"<th>{_escape(label)}</th>"
            f'<td class="numeric">{_escape(_number(selected_threshold, 4, "Abstain"))}</td>'
            f'<td class="numeric">{_escape(_percent(selected_point.get("precision") if selected_point else None, 1, "—"))}</td>'
            f'<td class="numeric">{_escape(_percent(selected_point.get("coverage") if selected_point else None, 1, "—"))}</td>'
            f'<td class="numeric">{_escape(_percent(max(qualified_coverages) if qualified_coverages else None, 1, "—"))}</td>'
            "</tr>"
        )

    grid = []
    axis_labels = []
    for tick in range(5):
        fraction = tick / 4
        x = left + fraction * (width - left - right)
        y = top + fraction * (height - top - bottom)
        grid.extend(
            (
                f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{height-bottom}" stroke="#dbe4ee" />',
                f'<line x1="{left}" y1="{y:.1f}" x2="{width-right}" y2="{y:.1f}" stroke="#dbe4ee" />',
            )
        )
        axis_labels.extend(
            (
                f'<text x="{x:.1f}" y="{height-18}" text-anchor="middle">{fraction * maximum_coverage * 100:.1f}%</text>',
                f'<text x="{left-8}" y="{y+4:.1f}" text-anchor="end">{(1-fraction) * 100:.0f}%</text>',
            )
        )
    target_line = ""
    if _is_number(target_precision):
        target_y = top + (1.0 - float(target_precision)) * (height - top - bottom)
        target_line = (
            f'<line x1="{left}" y1="{target_y:.1f}" x2="{width-right}" y2="{target_y:.1f}" '
            'stroke="#475569" stroke-width="1.5" stroke-dasharray="5 4" />'
            f'<text x="{width-right}" y="{target_y-5:.1f}" text-anchor="end">target {_percent(target_precision)}</text>'
        )
    return f"""
      <div class="tradeoff-panel">
        <h3>Threshold precision vs coverage</h3>
        <p class="subtle">Each line shows deployment coverage gained as a class threshold is relaxed. Circles mark installed thresholds.</p>
        <div class="tradeoff-layout">
          <div class="chart">
            <svg viewBox="0 0 {width} {height}" role="img" aria-label="Precision versus coverage for decisive sponsorship classes">
              {''.join(grid)}{''.join(axis_labels)}{target_line}{''.join(shapes)}
              <text x="{(left + width-right)/2:.1f}" y="{height-3}" text-anchor="middle">Coverage across evaluation split</text>
              <text x="15" y="{(top + height-bottom)/2:.1f}" text-anchor="middle" transform="rotate(-90 15 {(top + height-bottom)/2:.1f})">Precision</text>
            </svg>
            <div class="legend">{''.join(legend)}</div>
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>Class</th><th>Selected threshold</th><th>Precision</th><th>Coverage</th><th>Max coverage at target</th></tr></thead>
            <tbody>{''.join(table_rows)}</tbody>
          </table></div>
        </div>
      </div>
    """


def _error_text(row: dict[str, Any]) -> str:
    text = str(row.get("text") or "")
    evidence = row.get("evidence")
    if isinstance(evidence, dict) and evidence.get("text"):
        evidence_text = str(evidence["text"])
        if evidence_text and evidence_text != text:
            return f"{text}\nEvidence: {evidence_text}"
    return text


def _render_errors(metrics: dict[str, Any], max_errors: int) -> str:
    errors = metrics.get("error_examples")
    if not isinstance(errors, list):
        errors = []
    total = metrics.get("mistake_count")
    total_text = str(total) if _is_number(total) else str(len(errors))
    rows = []
    for row in errors[:max_errors]:
        if not isinstance(row, dict):
            continue
        confidence = _percent(row.get("confidence"), 1, "—")
        accepted = _status_pill("Accepted", "fail") if row.get("accepted") else _status_pill("Abstained", "warn")
        text = _error_text(row)
        summary = text if len(text) <= 150 else text[:147].rstrip() + "…"
        rows.append(
            "<tr>"
            f"<td><code>{_escape(row.get('id', '—'))}</code></td>"
            f"<td>{_escape(row.get('truth', '—'))}</td>"
            f"<td>{_escape(row.get('predicted', '—'))}</td>"
            f'<td class="numeric">{_escape(confidence)}</td>'
            f"<td>{accepted}</td>"
            "<td><details class=\"sample\">"
            f"<summary>{_escape(summary)}</summary><pre>{_escape(text)}</pre>"
            "</details></td>"
            "</tr>"
        )
    if not rows:
        return f'<p class="empty">No error examples recorded. Total mistakes: {_escape(total_text)}.</p>'
    return f"""
      <p class="subtle">Showing {len(rows)} of {_escape(total_text)} recorded mistakes, sorted by confidence.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>ID</th><th>Truth</th><th>Predicted</th><th>Confidence</th><th>Decision</th><th>Text</th></tr></thead>
        <tbody>{''.join(rows)}</tbody>
      </table></div>
    """


def _render_evaluation(bundle: EvaluationBundle, index: int, max_errors: int) -> str:
    metrics = bundle.metrics
    accepted = metrics.get("accepted_decisions") if isinstance(metrics.get("accepted_decisions"), dict) else {}
    inference = metrics.get("inference") if isinstance(metrics.get("inference"), dict) else {}
    labels = _labels_for_evaluation(metrics, bundle.thresholds)
    cards = "".join(
        (
            _metric_card("Examples", str(metrics.get("examples", "Not available"))),
            _metric_card("Accuracy", _percent(metrics.get("accuracy"))),
            _metric_card("Macro F1", _number(metrics.get("macro_f1"))),
            _metric_card("Accepted coverage", _percent(accepted.get("coverage"))),
            _metric_card("Accepted accuracy", _percent(accepted.get("accuracy"))),
            _metric_card("ECE", _number(metrics.get("expected_calibration_error"), 4)),
            _metric_card("Batch time / example", f"{_number(inference.get('milliseconds_per_example'), 2)} ms", "after model load"),
            _metric_card("Model size", _bytes(inference.get("model_bytes"))),
        )
    )
    verified = (
        _status_pill("Verified only", "pass")
        if metrics.get("verified_only") is True
        else _status_pill("Includes unverified", "warn")
    )
    runtime = metrics.get("runtime", "Not available")
    deployment = metrics.get("deployment_sha256")
    model_identity = deployment or metrics.get("model_sha256")
    deployment_short = (
        str(model_identity)[:16] + "…" if model_identity else "Not available"
    )
    return f"""
    <section id="evaluation-{index}">
      <div class="section-heading">
        <div><h2>Evaluation: {_escape(bundle.name)}</h2><p>{_escape(bundle.path)}</p></div>
        <div>{verified}</div>
      </div>
      <div class="metadata-line">
        <span>Split: <strong>{_escape(metrics.get('split', 'Not available'))}</strong></span>
        <span>Runtime: <strong>{_escape(runtime)}</strong></span>
        <span>Model identity: <code title="{_escape(model_identity or '')}">{_escape(deployment_short)}</code></span>
      </div>
      <div class="metrics">{cards}</div>
      <h3>Per-class quality and deployment thresholds</h3>
      {_render_class_metrics(bundle, labels)}
      {_render_threshold_tradeoffs(bundle)}
      <div class="two-column evaluation-detail">
        <div><h3>Confusion matrix</h3>{_render_confusion(metrics, labels)}</div>
        <div>
          <h3>Calibration and throughput</h3>
          <dl class="facts">
            <dt>Brier score</dt><dd>{_escape(_number(metrics.get('multiclass_brier_score'), 4))}</dd>
            <dt>Startup / model load</dt><dd>{_escape(_number(inference.get('startup_seconds'), 3))} s</dd>
            <dt>Batch inference time</dt><dd>{_escape(_number(inference.get('seconds'), 3))} s</dd>
            <dt>Total cold evaluation</dt><dd>{_escape(_number(inference.get('total_seconds'), 3))} s</dd>
            <dt>Examples / second</dt><dd>{_escape(_number(inference.get('examples_per_second'), 1))}</dd>
            <dt>Maximum tokens</dt><dd>{_escape(metrics.get('max_length', 'Not available'))}</dd>
            <dt>Recorded mistakes</dt><dd>{_escape(metrics.get('mistake_count', 'Not available'))}</dd>
          </dl>
        </div>
      </div>
      <details class="errors" open>
        <summary>Error audit</summary>
        {_render_errors(metrics, max_errors)}
      </details>
    </section>
    """


def _artifact_size(directory: Path | None, artifact: dict[str, Any]) -> int | None:
    if directory is None:
        return None
    files = artifact.get("files")
    if not isinstance(files, dict):
        return None
    total = 0
    for relative in files:
        path = directory / str(relative)
        if path.is_file():
            total += path.stat().st_size
    return total


def _render_artifact(artifact: dict[str, Any], directory: Path | None) -> str:
    if not artifact:
        return '<section id="artifact"><h2>Deployment artifact</h2><p class="empty">No artifact supplied.</p></section>'
    files = artifact.get("files") if isinstance(artifact.get("files"), dict) else {}
    release_ready = artifact.get("release_ready") is True
    release = _status_pill(
        "Release-ready" if release_ready else "Not release-ready",
        "pass" if release_ready else "warn",
    )
    cards = "".join(
        (
            _metric_card("Version", str(artifact.get("version", "Not available"))),
            _metric_card("Quantization", str(artifact.get("quantization", "Not available"))),
            _metric_card("Max tokens", str(artifact.get("max_length", "Not available"))),
            _metric_card("Packaged size", _bytes(_artifact_size(directory, artifact))),
        )
    )
    file_rows = "".join(
        "<tr>"
        f"<td><code>{_escape(name)}</code></td>"
        f"<td><code title=\"{_escape(checksum)}\">{_escape(str(checksum)[:20])}…</code></td>"
        "</tr>"
        for name, checksum in sorted(files.items())
    )
    calibration = artifact.get("calibration") if isinstance(artifact.get("calibration"), dict) else {}
    deployment = artifact.get("deployment_sha256") or "Not available"
    return f"""
    <section id="artifact">
      <div class="section-heading">
        <div><h2>Deployment artifact</h2><p>{_escape(directory or 'Not available')}</p></div>
        <div>{release}</div>
      </div>
      <div class="metrics">{cards}</div>
      <div class="two-column">
        <div>
          <h3>Package identity</h3>
          <dl class="facts">
            <dt>Deployment SHA-256</dt><dd><code class="hash">{_escape(deployment)}</code></dd>
            <dt>Task</dt><dd>{_escape(artifact.get('task', 'Not available'))}</dd>
            <dt>Labels</dt><dd>{_escape(', '.join(map(str, artifact.get('labels', []))))}</dd>
          </dl>
        </div>
        <div>
          <h3>Calibration</h3>
          <dl class="facts">
            <dt>Runtime</dt><dd>{_escape(calibration.get('runtime', 'Not installed'))}</dd>
            <dt>Selected on</dt><dd>{_escape(calibration.get('selected_on', 'Not installed'))}</dd>
            <dt>Target precision</dt><dd>{_escape(_percent(calibration.get('target_precision')))}</dd>
            <dt>Minimum decisions</dt><dd>{_escape(calibration.get('minimum_predictions', 'Not installed'))}</dd>
          </dl>
        </div>
      </div>
      <details><summary>Packaged file manifest ({len(files)} files)</summary>
        <div class="table-wrap"><table><thead><tr><th>File</th><th>SHA-256</th></tr></thead>
        <tbody>{file_rows or '<tr><td colspan="2">No manifest available.</td></tr>'}</tbody></table></div>
      </details>
    </section>
    """


def _render_run(run: dict[str, Any], run_path: Path | None) -> str:
    if not run:
        return ""
    configuration = (
        run.get("configuration")
        if isinstance(run.get("configuration"), dict)
        else {}
    )
    stages = run.get("stages") if isinstance(run.get("stages"), list) else []
    status = str(run.get("status") or "unknown")
    status_tone = (
        "pass" if status == "completed"
        else "fail" if status == "failed"
        else "warn"
    )
    cards = "".join(
        (
            _metric_card("Run", str(run.get("run_name", "Not available"))),
            _metric_card("Mode", str(run.get("mode", "Not available"))),
            _metric_card("Status", status),
            _metric_card("Started", str(run.get("started_at", "Not available"))),
        )
    )
    configuration_rows = "".join(
        f"<tr><th>{_escape(key.replace('_', ' ').title())}</th><td>{_escape(value)}</td></tr>"
        for key, value in sorted(configuration.items())
    )
    stage_rows = []
    for stage in stages:
        if not isinstance(stage, dict):
            continue
        stage_status = str(stage.get("status") or "unknown")
        tone = (
            "pass" if stage_status == "completed"
            else "fail" if stage_status == "failed"
            else "info" if stage_status == "skipped"
            else "warn"
        )
        command = stage.get("command")
        command_text = " ".join(map(str, command)) if isinstance(command, list) else ""
        command_cell = (
            f'<details class="sample"><summary>Show command</summary><pre>{_escape(command_text)}</pre></details>'
            if command_text
            else _escape(stage.get("reason", "—"))
        )
        stage_rows.append(
            "<tr>"
            f"<td>{_escape(stage.get('name', 'Unnamed stage'))}</td>"
            f"<td>{_status_pill(stage_status, tone)}</td>"
            f'<td class="numeric">{_escape(_number(stage.get("duration_seconds"), 2, "—"))}</td>'
            f"<td>{command_cell}</td>"
            "</tr>"
        )
    return f"""
    <section id="experiment">
      <div class="section-heading">
        <div><h2>Experiment</h2><p>{_escape(run_path or 'Not available')}</p></div>
        <div>{_status_pill(status, status_tone)}</div>
      </div>
      <div class="metrics">{cards}</div>
      <div class="two-column">
        <div><h3>Configuration</h3><div class="table-wrap"><table><tbody>
          {configuration_rows or '<tr><td>No configuration recorded.</td></tr>'}
        </tbody></table></div></div>
        <div><h3>Dataset identity</h3><dl class="facts">
          <dt>Path</dt><dd>{_escape(run.get('data', 'Not available'))}</dd>
          <dt>SHA-256</dt><dd><code class="hash">{_escape(run.get('data_sha256', 'Not available'))}</code></dd>
          <dt>Splits</dt><dd>{_escape(', '.join(map(str, run.get('available_splits', []))))}</dd>
          <dt>Research only</dt><dd>{_escape(run.get('research_only', 'Not available'))}</dd>
        </dl></div>
      </div>
      <h3>Pipeline stages</h3>
      <div class="table-wrap"><table><thead><tr><th>Stage</th><th>Status</th><th>Seconds</th><th>Command / reason</th></tr></thead>
        <tbody>{''.join(stage_rows) or '<tr><td colspan="4">No stages recorded.</td></tr>'}</tbody>
      </table></div>
    </section>
    """


def _render_readiness(
    evaluations: Sequence[EvaluationBundle], artifact: dict[str, Any]
) -> str:
    by_split = {
        str(bundle.metrics.get("split") or bundle.name).lower(): bundle
        for bundle in evaluations
    }
    checks: list[tuple[str, str, str]] = []
    validation = by_split.get("validation")
    test = by_split.get("test")
    checks.append(
        (
            "Validation evaluation",
            "Available" if validation else "Missing",
            "pass" if validation else "warn",
        )
    )
    checks.append(
        (
            "Independent test evaluation",
            "Available" if test else "Missing",
            "pass" if test else "warn",
        )
    )
    calibration = artifact.get("calibration") if isinstance(artifact.get("calibration"), dict) else {}
    calibrated = (
        calibration.get("selected_on") == "validation"
        and calibration.get("verified_only") is True
    )
    checks.append(
        (
            "Installed validation thresholds",
            "Verified-only ONNX calibration" if calibrated else "Not installed or incomplete",
            "pass" if calibrated else "warn",
        )
    )
    artifact_hash = artifact.get("deployment_sha256")
    reported_hashes = {
        bundle.metrics.get("deployment_sha256")
        for bundle in evaluations
        if bundle.metrics.get("deployment_sha256")
    }
    identity_ok = bool(artifact_hash and reported_hashes and reported_hashes == {artifact_hash})
    checks.append(
        (
            "Deployment identity",
            "All reports match" if identity_ok else "Missing or inconsistent hashes",
            "pass" if identity_ok else "warn",
        )
    )
    released = artifact.get("release_ready") is True
    checks.append(
        (
            "Release flag",
            "Approved" if released else "Not approved",
            "pass" if released else "warn",
        )
    )
    rows = "".join(
        f"<tr><td>{_escape(name)}</td><td>{_status_pill(value, tone)}</td></tr>"
        for name, value, tone in checks
    )
    return f"""
    <section id="readiness">
      <h2>Readiness checklist</h2>
      <p class="subtle">This checklist summarizes recorded artifacts; it is not an automatic release approval.</p>
      <div class="table-wrap"><table><thead><tr><th>Check</th><th>Status</th></tr></thead><tbody>{rows}</tbody></table></div>
    </section>
    """


def _navigation(
    evaluations: Sequence[EvaluationBundle], has_artifact: bool, has_run: bool
) -> str:
    links = []
    if has_run:
        links.append('<a href="#experiment">Experiment</a>')
    links.extend(('<a href="#dataset">Dataset</a>', '<a href="#training">Training</a>'))
    links.extend(
        f'<a href="#evaluation-{index}">{_escape(bundle.name)}</a>'
        for index, bundle in enumerate(evaluations, start=1)
    )
    if has_artifact:
        links.append('<a href="#artifact">Artifact</a>')
    links.append('<a href="#readiness">Readiness</a>')
    return "".join(links)


CSS = r"""
:root {
  color-scheme: light;
  --ink: #172033;
  --muted: #64748b;
  --line: #d9e2ec;
  --panel: #ffffff;
  --canvas: #f4f7fa;
  --brand: #0f766e;
  --brand-soft: #ccfbf1;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  color: var(--ink);
  background: var(--canvas);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
header {
  color: white;
  background: linear-gradient(130deg, #0b1324 0%, #123149 58%, #0f766e 100%);
  padding: 44px max(24px, calc((100vw - 1240px) / 2));
}
header .eyebrow { color: #99f6e4; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
header h1 { margin: 7px 0 8px; font-size: clamp(30px, 4vw, 52px); line-height: 1.08; }
header p { max-width: 760px; color: #d7e4ef; font-size: 16px; margin: 0; }
nav {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 10px max(24px, calc((100vw - 1240px) / 2));
  background: rgba(255,255,255,.96);
  border-bottom: 1px solid var(--line);
}
nav a { color: #334155; text-decoration: none; font-weight: 700; padding: 7px 11px; border-radius: 8px; white-space: nowrap; }
nav a:hover { background: #e7edf3; }
main { width: min(1240px, calc(100% - 32px)); margin: 26px auto 60px; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 18px; padding: 24px; margin: 18px 0; box-shadow: 0 8px 24px rgba(15,23,42,.045); }
h2 { margin: 0 0 16px; font-size: 24px; letter-spacing: -.02em; }
h3 { margin: 20px 0 10px; font-size: 16px; }
p { margin: 8px 0; }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.section-heading h2 { margin-bottom: 2px; }
.section-heading p, .subtle, .axis-note { color: var(--muted); }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 14px 0 22px; }
.metric-card { min-width: 0; padding: 14px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; }
.metric-label { color: var(--muted); font-size: 12px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.metric-value { margin-top: 4px; font-size: 21px; font-weight: 800; overflow-wrap: anywhere; }
.metric-hint { color: var(--muted); font-size: 12px; }
.two-column, .charts { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 22px; }
.evaluation-detail { align-items: start; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 11px; }
table { width: 100%; border-collapse: collapse; background: white; }
th, td { padding: 9px 11px; border-bottom: 1px solid #e8eef4; text-align: left; vertical-align: top; }
thead th { color: #475569; background: #f8fafc; font-size: 12px; letter-spacing: .03em; }
tbody tr:last-child > * { border-bottom: 0; }
tbody th { font-weight: 750; }
.numeric { text-align: right; font-variant-numeric: tabular-nums; }
.total { background: #f8fafc; }
.bar { height: 4px; margin-top: 5px; background: #e2e8f0; border-radius: 99px; overflow: hidden; min-width: 70px; }
.bar span { display: block; height: 100%; background: var(--brand); }
.chart { min-width: 0; padding: 2px 0; }
.chart svg { width: 100%; height: auto; background: #fbfdff; border: 1px solid var(--line); border-radius: 10px; }
.chart svg text { fill: #64748b; font-family: inherit; font-size: 11px; }
.legend { display: flex; gap: 15px; flex-wrap: wrap; color: #475569; font-size: 12px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 15px; height: 3px; display: inline-block; border-radius: 2px; }
.tradeoff-panel { margin: 22px 0; padding-top: 2px; }
.tradeoff-layout { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(360px, .85fr); gap: 20px; align-items: start; }
.status { display: inline-block; border-radius: 99px; padding: 4px 9px; font-size: 12px; font-weight: 800; }
.status.pass { color: #166534; background: #dcfce7; }
.status.warn { color: #92400e; background: #fef3c7; }
.status.fail { color: #991b1b; background: #fee2e2; }
.status.info { color: #1e40af; background: #dbeafe; }
.metadata-line { display: flex; flex-wrap: wrap; gap: 12px 24px; color: var(--muted); padding: 9px 0; }
.metadata-line strong { color: var(--ink); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; overflow-wrap: anywhere; }
.hash { word-break: break-all; }
.matrix { min-width: 590px; }
.matrix-cell { text-align: center; font-weight: 800; font-variant-numeric: tabular-nums; }
.facts { display: grid; grid-template-columns: minmax(130px, .7fr) minmax(0, 1.3fr); margin: 0; border: 1px solid var(--line); border-radius: 11px; overflow: hidden; }
.facts dt, .facts dd { margin: 0; padding: 9px 11px; border-bottom: 1px solid #e8eef4; }
.facts dt { background: #f8fafc; color: #475569; font-weight: 700; }
.facts dd { overflow-wrap: anywhere; }
details { margin-top: 14px; }
details > summary { cursor: pointer; font-weight: 800; padding: 8px 0; }
.errors > summary { font-size: 17px; }
.sample { margin: 0; max-width: 520px; }
.sample summary { font-weight: 500; color: #334155; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; padding: 10px; background: #f8fafc; border-radius: 8px; font-family: inherit; }
.empty { color: var(--muted); padding: 16px; background: #f8fafc; border-radius: 10px; }
.warnings { border-color: #fcd34d; background: #fffbeb; }
.warnings li { margin: 4px 0; }
footer { width: min(1240px, calc(100% - 32px)); margin: -35px auto 36px; color: var(--muted); font-size: 12px; }
@media (max-width: 820px) {
  .two-column, .charts, .tradeoff-layout { grid-template-columns: 1fr; }
  .section-heading { display: block; }
  .section-heading .status { margin-top: 8px; }
  section { padding: 18px; border-radius: 14px; }
}
@media print {
  body { background: white; }
  nav { display: none; }
  header { padding: 24px; background: #0b1324 !important; print-color-adjust: exact; }
  main { width: 100%; margin: 0; }
  section { box-shadow: none; break-inside: avoid; }
  details > * { display: block !important; }
}
"""


def generate_report(
    *,
    data_path: Path | None = None,
    run_path: Path | None = None,
    trainer_path: Path | None = None,
    evaluation_specs: Sequence[tuple[str | None, Path]] = (),
    artifact_path: Path | None = None,
    title: str | None = None,
    max_errors: int = 30,
) -> str:
    """Load report inputs and return one self-contained HTML document."""
    if max_errors < 0:
        raise ReportError("max_errors must be zero or greater")
    warnings: list[str] = []
    run = _read_json(run_path) if run_path is not None else {}
    examples = _read_jsonl(data_path) if data_path is not None else []
    dataset = _dataset_summary(examples) if data_path is not None else {}

    trainer_state: dict[str, Any] = {}
    training_metadata: dict[str, Any] = {}
    if trainer_path is not None:
        trainer_state, training_metadata, trainer_warnings = _load_trainer(trainer_path)
        warnings.extend(trainer_warnings)

    evaluations = [
        _load_evaluation(name, source) for name, source in evaluation_specs
    ]

    artifact: dict[str, Any] = {}
    artifact_directory: Path | None = None
    if artifact_path is not None:
        if artifact_path.is_dir():
            artifact_directory = artifact_path
            manifest = artifact_path / "artifact.json"
        else:
            artifact_directory = artifact_path.parent
            manifest = artifact_path
        artifact = _read_json(manifest)

    if not any((data_path, run_path, trainer_path, evaluations, artifact_path)):
        warnings.append("No report inputs were supplied.")

    warning_html = ""
    if warnings:
        warning_html = (
            '<section class="warnings"><h2>Input notes</h2><ul>'
            + "".join(f"<li>{_escape(warning)}</li>" for warning in warnings)
            + "</ul></section>"
        )

    evaluation_html = "".join(
        _render_evaluation(bundle, index, max_errors)
        for index, bundle in enumerate(evaluations, start=1)
    )
    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    resolved_title = title or (
        f"SponsorLens · {run.get('run_name')}"
        if run.get("run_name")
        else "SponsorLens local model report"
    )
    overview_cards = "".join(
        (
            _metric_card("Dataset examples", str(dataset.get("examples", "Not available"))),
            _metric_card("Evaluations", str(len(evaluations))),
            _metric_card("Artifact version", str(artifact.get("version", "Not available"))),
            _metric_card("Run mode", str(run.get("mode", "Not available"))),
            _metric_card(
                "Release status",
                "Ready" if artifact.get("release_ready") is True else "Not ready",
            ),
        )
    )
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>{_escape(resolved_title)}</title>
  <style>{CSS}</style>
</head>
<body>
  <header>
    <div class="eyebrow">SponsorLens · Offline training report</div>
    <h1>{_escape(resolved_title)}</h1>
    <p>Dataset composition, Trainer history, calibrated evaluation results, error samples, and packaged artifact provenance in one local file.</p>
  </header>
  <nav aria-label="Report sections">{_navigation(evaluations, bool(artifact), bool(run))}</nav>
  <main>
    <section id="overview"><h2>Overview</h2><div class="metrics">{overview_cards}</div>
      <p class="subtle">Generated {_escape(generated_at)}. All content and styles are embedded; this report makes no network requests.</p>
    </section>
    {warning_html}
    {_render_run(run, run_path)}
    {_render_dataset(dataset, data_path)}
    {_render_training(trainer_state, training_metadata)}
    {evaluation_html or '<section><h2>Evaluation</h2><p class="empty">No evaluation reports supplied.</p></section>'}
    {_render_artifact(artifact, artifact_directory)}
    {_render_readiness(evaluations, artifact)}
  </main>
  <footer>Generated by <code>training/report.py</code>. Treat release readiness as a human-reviewed decision.</footer>
</body>
</html>
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate a self-contained offline SponsorLens training report."
    )
    parser.add_argument("--data", type=Path, help="Training/evaluation JSONL dataset.")
    parser.add_argument("--run", type=Path, help="run_experiment.py run.json manifest.")
    parser.add_argument(
        "--trainer",
        type=Path,
        help="Trainer output directory, trainer_state.json, or training_metadata.json.",
    )
    parser.add_argument(
        "--training",
        type=Path,
        help="Alias for --trainer used by run_experiment.py.",
    )
    parser.add_argument(
        "--evaluation",
        action="append",
        default=[],
        metavar="[NAME=]PATH",
        help="Evaluation directory or metrics.json; repeat for validation/test/challenge.",
    )
    parser.add_argument(
        "--evaluations",
        type=Path,
        help="Root directory whose immediate children contain metrics.json.",
    )
    parser.add_argument(
        "--artifact",
        type=Path,
        help="Packaged model directory or artifact.json.",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--title")
    parser.add_argument("--max-errors", type=int, default=30)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.trainer and args.training and args.trainer != args.training:
            raise ReportError("--trainer and --training point to different inputs")
        trainer_path = args.training or args.trainer
        evaluation_specs = [
            parse_evaluation_spec(value) for value in args.evaluation
        ]
        if args.evaluations:
            evaluation_specs.extend(discover_evaluations(args.evaluations))
        report = generate_report(
            data_path=args.data,
            run_path=args.run,
            trainer_path=trainer_path,
            evaluation_specs=evaluation_specs,
            artifact_path=args.artifact,
            title=args.title,
            max_errors=args.max_errors,
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report, encoding="utf-8")
    except (OSError, ReportError) as error:
        raise SystemExit(str(error)) from error
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
