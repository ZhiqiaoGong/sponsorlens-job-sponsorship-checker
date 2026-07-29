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

Version 0.1.0 has no server and does not call external AI services. Page text is analyzed only in the current browser tab and is never uploaded.

SponsorLens needs access to HTTP and HTTPS pages so it can scan job listings automatically. Chrome internal pages, the Chrome Web Store, and some built-in PDF viewers do not allow extensions to run.

## Settings

Click the gear icon in the extension popup to:

- Hide the status tab shown on the page.
- Turn off automatic rescanning on dynamic pages.
- Hide the toolbar badge.
- Add custom no-sponsorship or sponsorship phrases.

## Page indicator behavior

- A clear result opens automatically only the first time a job is recognized in the current tab session.
- The result collapses after a few seconds. Hovering pauses the timer.
- Scrolling, typing, or interacting with the page collapses an automatically opened result immediately.
- Dynamic rescans update the edge tab silently and never reopen the result.
- Application flows such as Workday forms are scanned silently without automatic presentation.
- **Not mentioned** stays collapsed as a subtle gray tab.
- Edge labels use **NO**, **YES**, **LIMITED**, **UNCLEAR**, and **NO INFO** so conditional and inconclusive results remain distinct.
- Use **Hide on this page** to remove the tab for the rest of the current page session.

## Known limitations

- Rule-based analysis cannot understand every employer policy. Always review the displayed evidence.
- A company-wide hiring policy may conflict with a specific job listing. When results conflict, SponsorLens conservatively prioritizes no-sponsorship language.
- Workday, LinkedIn, and similar sites may load job text in stages. SponsorLens automatically rescans dynamic pages; use **Scan again** in the popup when needed.
- Text inside cross-origin iframes, images, or unopened collapsed sections may not be readable.
- `Must be authorized to work in the US` alone is marked **Needs review**, not **No sponsorship**.

## Development

SponsorLens uses Chrome Manifest V3 with no build step or third-party runtime dependencies.

The core rules are in `lib/analyzer.js`. After changing a file, click the reload button on the extension card at `chrome://extensions`, then refresh the job listing.
