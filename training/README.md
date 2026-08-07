# SponsorLens local classifier

This directory contains the reproducible data, training, evaluation, and export
pipeline for the optional on-device classifier. The classifier works on short
evidence windows, not on an entire web page.

## Labels

- `no`: the window says sponsorship is unavailable or imposes an eligibility
  restriction that excludes sponsored workers.
- `conditional`: sponsorship depends on visa type, seniority, role, timing, or
  case-by-case approval.
- `yes`: the window explicitly offers sponsorship or visa support.
- `review`: the window contains work authorization, export control, or clearance
  language that does not answer sponsorship by itself.
- `irrelevant`: the window contains a trigger word but is not evidence about job
  sponsorship.

`unknown` is intentionally not a model label. It is the page-level result when
no candidate window produces an accepted prediction.

## Safety contract

The extension-side policy lives in `lib/local-model-policy.js` and enforces these
rules independently of the model:

1. Run only on individual job listings whose rule result is `review` or
   `unknown`.
2. Never override a deterministic `no`, `yes`, or `conditional` result.
3. Require an exact source window and a calibrated per-class threshold before
   changing the result.
4. Fall back to `review` when decisive model predictions conflict.
5. Leave the rule result unchanged when the model is missing, fails, or abstains.

## Data format

Training data is JSON Lines validated by `schema.json`. `group_id` is mandatory:
all examples from the same company, job, or reused template must remain in one
split. This prevents nearly identical employer boilerplate from appearing in
both training and evaluation data.

The checked-in `data/seed.jsonl` is a contract and smoke-test dataset. It is not
large or independent enough to measure production accuracy. A release model
needs a deduplicated, human-verified corpus and a company/template-disjoint test
set.

## Collecting reviewed examples

SponsorLens 0.4.0 can build a local review queue without uploading browsing
data:

1. Open **SponsorLens Settings** and enable **Save job-language samples on this
   device**. The setting is device-local and off by default.
2. Browse individual job listings normally. The extension saves every eligible
   observation and stores at most three short candidate passages per job. For
   each saved observation, an unchanged page result is recorded as assumed
   correct; use **Wrong result?** on the page whenever the scanner is wrong.
3. Open **Review observations** from Settings. Label every passage, select exact
   evidence (or use the full passage), and save it. Page-level feedback without
   a candidate passage is kept for diagnostics but cannot become training data.
4. Choose **Export ready** to download a JSONL file. Pending suggestions are
   never exported as verified examples, and export does not delete local data.

The collector excludes non-job pages, manual page-wide scans, application
flows, full page text, raw tracking URLs, and passages containing email
addresses or phone numbers. Repeated scans of the same job are merged. The
queue is capped at 500 jobs and never evicts an existing sample automatically.
It also keeps a compact local export ledger containing only deterministic row
IDs, labels, and timestamps. This prevents later batches from duplicating or
contradicting earlier exports even after queue entries are edited or deleted.
The most recent exported batch is retained locally as a recoverable receipt, so
**Download last export** can recreate the file after an interrupted download.
Clearing the queue removes that receipt but keeps the compact duplicate ledger.
If you later correct the evidence or Group ID for a row from the same capture,
the next export includes a replacement with the same row ID; replace the older
row instead of appending both copies to one dataset.

Validate an exported file before using it:

```sh
python3 training/validate_data.py ~/Downloads/sponsorlens-training-YYYY-MM-DD.jsonl
```

Validate data:

```sh
python3 training/validate_data.py training/data/seed.jsonl
```

Validation also runs the JavaScript candidate extractor used by the extension.
Every training row must equal a window the runtime can actually produce; a
full job description or an unreachable sentence is rejected.

Run the lightweight TF-IDF baseline to verify the split and metrics pipeline:

```sh
python3 training/baseline.py training/data/seed.jsonl
```

## Fine-tuning

Create a virtual environment and install `requirements.txt`, then fine-tune the
small four-layer encoder:

```sh
python3 training/train.py \
  --data training/data/jobs.jsonl \
  --output training/output/bert-mini
```

The default base model is `google/bert_uncased_L-4_H-256_A-4`, with a maximum
input length of 192 tokens. The first run downloads that base model.

Each run writes strict JSON Lines to
`OUTPUT/training_history.jsonl`. The history includes run metadata, every
logged optimizer step, epoch boundaries, evaluation metrics, checkpoints, and
the final training event. Step metrics default to every optimizer step; use
`--logging-steps N` to reduce that frequency. Terminal updates are intentionally
less frequent and can be adjusted with `--progress-steps N`. Use
`--history-file PATH` when the history should live outside the checkpoint
directory.

## Observable end-to-end runs

Use the experiment runner when you want the complete process streamed to the
terminal, retained as stage logs, and rendered as one standalone HTML report:

```sh
python3 training/run_experiment.py \
  --smoke \
  --run-name my-visible-smoke
```

Smoke mode deliberately uses `data/seed.jsonl` for one epoch. It verifies the
pipeline but can never approve a model for release. The runner refuses to use
the seed file unless `--smoke` is explicit, never reuses an existing run
directory, fingerprints the dataset, and preserves failed runs for diagnosis.

For a real quantized candidate, use a human-verified corpus and deployment
mode. Pinning the base-model revision makes the starting weights reproducible:

```sh
python3 training/run_experiment.py \
  --mode deployment \
  --data training/data/jobs.jsonl \
  --run-name candidate-v1 \
  --base-revision HUGGING_FACE_COMMIT_SHA
```

Each run produces:

```text
training/output/RUN_NAME/checkpoint/
training/output/RUN_NAME/artifact/          # deployment mode only
training/reports/RUN_NAME/run.json
training/reports/RUN_NAME/logs/
training/reports/RUN_NAME/evaluations/
training/reports/RUN_NAME/index.html
```

The HTML is fully offline and contains dataset distributions, training curves,
per-class metrics, confusion matrices, calibrated precision-versus-coverage
curves, high-confidence mistakes, inference setup/throughput measurements, and
artifact provenance. A completed pipeline is not the same as an approved
model: release readiness remains false until independent evaluation and the
packaged browser-runtime parity check pass.

Do not select a release checkpoint using the test set. Train on `train`, select
thresholds on `validation`, and report final metrics once on `test`. Keep a
separate `challenge` split for clearance, ITAR, citizenship exceptions, page
collections, product documentation, and collapsed LinkedIn descriptions.

## Export, evaluation, and thresholds

Export the checkpoint to dynamic-int8 ONNX before selecting deployment
thresholds. Quantization can change logits, so thresholds measured on the
PyTorch checkpoint must not be copied to the browser artifact.

```sh
python3 training/export_onnx.py \
  --model training/output/bert-mini \
  --output models/sponsorlens

python3 training/evaluate.py \
  --model models/sponsorlens \
  --onnx models/sponsorlens/onnx/model_quantized.onnx \
  --data training/data/jobs.jsonl \
  --split validation \
  --output training/reports/validation

python3 training/install_thresholds.py \
  --artifact models/sponsorlens \
  --thresholds training/reports/validation/thresholds.json

python3 training/evaluate.py \
  --model models/sponsorlens \
  --onnx models/sponsorlens/onnx/model_quantized.onnx \
  --data training/data/jobs.jsonl \
  --split test \
  --thresholds models/sponsorlens/thresholds.json \
  --output training/reports/test
```

The evaluator reports per-class precision/recall/F1, confusion matrix, Brier
score, expected calibration error, and accepted-decision coverage. Thresholds
for `no`, `yes`, and `conditional` target high precision and may deliberately
abstain on many examples. A missing calibrated threshold is stored as `null`,
which always means abstain—even when a model emits a score of `1.0`.

`artifact.json` binds the ONNX graph, tokenizer files, label order, and maximum
token length into one deployment checksum. `install_thresholds.py` accepts only
verified-only validation thresholds carrying that exact checksum and rejects
invalid values outside zero to one. Before enabling the model, repeat inference
in the packaged browser runtime and confirm parity with ONNX Runtime; thresholds
are not considered release-ready until that check and the independent test
report both pass.

The expected packaged artifact is:

```text
models/sponsorlens/
  artifact.json
  config.json
  tokenizer.json
  tokenizer_config.json
  special_tokens_map.json
  thresholds.json
  model-card.md
  onnx/model_quantized.onnx
```

The model should not be wired into the extension UI until held-out evaluation
shows that decisive `no` and `yes` predictions meet the chosen precision target.
