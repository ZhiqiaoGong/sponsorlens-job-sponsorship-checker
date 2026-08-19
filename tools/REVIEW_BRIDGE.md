# One-off Review bridge

This developer-only helper moves Pending SponsorLens review items through a
JSON file so a local or external assistant can label them. It is not included
in the extension manifest and adds no production UI.

## 1. Load the helper

1. Reload SponsorLens once from `chrome://extensions` so the newly added tool
   file is included.
2. Open **SponsorLens Settings → Review observations** and refresh the page.
3. Open Chrome DevTools on that Review page and choose **Console**.
4. Run:

```js
await import(chrome.runtime.getURL("tools/review-bridge.js"))
```

5. Confirm the Console says `SponsorLens review bridge loaded`.

The Console context must be the SponsorLens Review page, not the extension
service worker.

## 2. Export Pending items

Run in the Review page Console:

```js
await exportPending()
```

Chrome downloads `sponsorlens-review-queue-YYYY-MM-DD.json`. It contains only
the short candidate passages already stored by the local collector, not full
job descriptions or raw tracking URLs.

## 3. Ask an assistant to edit the file

Attach the JSON file and use this prompt:

```text
Edit this SponsorLens review-queue JSON file and return a valid downloadable
JSON file with the same structure.

For each item you can confidently complete, set apply to true, verify or update
pageResult.finalStatus and groupId, then label every candidate:
- irrelevant: not evidence about job sponsorship; evidenceText must be null
- no: sponsorship is unavailable or sponsored workers are excluded
- conditional: sponsorship depends on a visa type, level, timing, or condition
- yes: sponsorship or visa support is explicitly available
- review: work authorization, export control, or clearance is relevant but does
  not answer sponsorship

For every non-irrelevant label, evidenceText must be the shortest
self-contained, exact, case-sensitive substring copied from candidate.text. If
the substring occurs twice, include more surrounding words until it is unique.
Do not modify IDs, fingerprints, candidate text, or suggested fields. Leave
apply=false when the saved passage lacks enough context. Do not invent facts
from the original job page.
```

## 4. Import completed reviews

Run:

```js
await importReviews()
```

Choose the JSON returned by the assistant. The bridge skips records that are
already Ready or Exported and rejects changed passages, stale fingerprints,
invalid labels, missing evidence, non-exact evidence, and incomplete reviews.
Refresh the Review page afterward to see the new Ready count.

An item whose final result is `not-job` is saved as diagnostic feedback and
cannot become Ready. Items left with `apply=false` remain Pending.
