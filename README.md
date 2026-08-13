# SponsorLens

SponsorLens is a local Chrome extension that scans job listings for sponsorship, work authorization, citizenship, export control, and security clearance language. It shows the exact text supporting each result.

## Installation

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the entire `sponsorlens` folder.
5. Open a job listing and refresh the page once.

On a job listing, the extension briefly opens the first clear result and then collapses it into a compact status tab on the left edge. Click the tab or toolbar icon to review the evidence and locate the original text.

## Results

- Red **No sponsorship**: The listing explicitly says sponsorship is unavailable, candidates must not need sponsorship now or in the future, or the role is limited by citizenship or permanent residency.
- Yellow **Conditional sponsorship**: Sponsorship depends on seniority, visa type, transfer status, or case-by-case approval.
- Green **Sponsorship available**: The listing explicitly offers sponsorship or visa support.
- Yellow **Needs review**: The listing mentions current work authorization, U.S. person status, export controls, or security clearance without clearly answering the sponsorship question.
- Gray **Not mentioned**: The listing contains no clear sponsorship statement. This does not mean the employer offers sponsorship.

## Privacy

SponsorLens 0.4.1 has no server and does not call external AI services. Page text is analyzed only in the current browser tab and is never uploaded.

The optional local data collection setting is off by default. When enabled, it
keeps eligible short sponsorship-related passages in `chrome.storage.local` as
local observations; it does not save full job descriptions, application forms,
or raw tracking URLs. Nothing is uploaded automatically. The page result is
treated as correct unless you change it, but this default applies only to
page-level feedback. Only passages whose labels and exact evidence you review
can be exported as verified JSONL training rows.

SponsorLens needs access to HTTP and HTTPS pages so it can scan job listings automatically. Chrome internal pages, the Chrome Web Store, and some built-in PDF viewers do not allow extensions to run.

## Settings

Click the gear icon in the extension popup to:

- Hide the status tab shown on the page.
- Turn off automatic rescanning on dynamic pages.
- Hide the toolbar badge.
- Add custom no-sponsorship or sponsorship phrases.
- Enable local observation collection and open the Review page.

## Page indicator behavior

- Automatic sponsorship decisions run only on pages that appear to contain one individual job listing.
- A clear result opens automatically only the first time a job is recognized in the current tab session.
- The result collapses after a few seconds. Hovering pauses the timer.
- Scrolling, typing, or interacting with the page collapses an automatically opened result immediately.
- Dynamic rescans update the edge tab silently and never reopen the result.
- Application flows such as Workday forms are scanned silently without automatic presentation.
- **Not mentioned** stays collapsed as a subtle gray tab.
- Edge labels use **NO**, **YES**, **LIMITED**, **UNCLEAR**, and **NO INFO** so conditional and inconclusive results remain distinct.
- Use **Hide on this page** to remove the tab for the rest of the current page session.
- When local collection is enabled, an unchanged page result is saved as correct by default. Use **Wrong result?** to record a correction; corrected items are prioritized in Review. Feedback without a relevant passage remains diagnostic-only and cannot be exported.

On documentation, job collections, and other pages that do not look like an individual job listing, SponsorLens does not make an automatic decision or show a badge. Open the popup and choose **Scan entire page anyway** to run a one-time page-wide scan. Page-wide results stay in the popup, do not create a page indicator, and include a warning that unrelated jobs, legends, or documentation may be combined.

## Known limitations

- Rule-based analysis cannot understand every employer policy. Always review the displayed evidence.
- A company-wide hiring policy may conflict with a specific job listing. When results conflict, SponsorLens conservatively prioritizes no-sponsorship language.
- Workday, LinkedIn, and similar sites may load job text in stages. SponsorLens automatically rescans dynamic pages; use **Scan again** in the popup when needed.
- Text inside cross-origin iframes, images, or unopened collapsed sections may not be readable.
- `Must be authorized to work in the US` alone is marked **Needs review**, not **No sponsorship**.
- Page classification is heuristic. Use **Scan entire page anyway** when a real job description is not recognized.

## Development

SponsorLens uses Chrome Manifest V3 with no build step or third-party runtime dependencies.

The core rules are in `lib/analyzer.js`. After changing a file, click the reload button on the extension card at `chrome://extensions`, then refresh the job listing.

The optional local-classifier work is isolated in `lib/local-model-policy.js` and
`training/`. The policy extracts a small number of relevant text windows and
allows only calibrated predictions to supplement `Needs review` or `Not
mentioned`; it never overrides a clear rule result. The checked-in seed dataset
is for pipeline tests only, so no model is enabled in the extension yet. See
`training/README.md` for validation, training, evaluation, and ONNX export.

The local collection pipeline is implemented in `lib/collector.js`,
`background.js`, and `collector/`. It stores at most 500 job captures, merges
repeat scans until a human review is completed, requires exact evidence for
reviewed labels, and exports only human-reviewed examples that match the
training schema. Completed reviews are locked against automatic rescans; only
an explicit edit on the Review page can move one back to Pending. A compact device-local
ledger stores only exported row IDs, labels, and timestamps so later exports
cannot silently duplicate or contradict earlier files; deleting queue items
does not erase that history. The Review page also keeps one recoverable local
copy of the most recent export, which can be downloaded again until it is
replaced or the queue is explicitly cleared. A corrected row from the same
capture is exported again with the same row ID so it can replace the earlier
version without creating a second training example.

Run the regression tests with:

```sh
node --test tests/*.test.js
```
