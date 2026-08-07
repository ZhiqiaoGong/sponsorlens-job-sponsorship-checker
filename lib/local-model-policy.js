(function sponsorLensLocalModelPolicyFactory(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.SponsorLensLocalModelPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPolicy() {
  "use strict";

  const VERSION = "0.1.0";
  const WINDOW_LABELS = new Set([
    "irrelevant",
    "no",
    "conditional",
    "yes",
    "review"
  ]);
  const DECISIVE_LABELS = new Set(["no", "conditional", "yes"]);
  const STATUS_META = {
    no: {
      label: "No sponsorship",
      shortLabel: "No Sponsor",
      summary: "The local model found language indicating sponsorship is not available.",
      color: "#dc2626"
    },
    conditional: {
      label: "Conditional sponsorship",
      shortLabel: "Conditional",
      summary: "The local model found language indicating sponsorship has conditions.",
      color: "#d97706"
    },
    yes: {
      label: "Sponsorship available",
      shortLabel: "Sponsor",
      summary: "The local model found language indicating sponsorship is available.",
      color: "#15803d"
    },
    review: {
      label: "Needs review",
      shortLabel: "Review",
      summary: "Related eligibility language was found, but the sponsorship answer is not clear.",
      color: "#ca8a04"
    }
  };
  const SIGNAL_PATTERN = /\b(?:sponsor(?:ed|ing|ship)?|visa(?:s)?|immigration|immigration\s+petitions?|employment\s+petitions?|work\s+permits?|work\s+authori[sz]ation|authori[sz]ation\s+to\s+work|authori[sz]ed\s+to\s+work|permitted\s+to\s+work|employment\s+authori[sz]ation|H-?1B|O-?1|E-?3|TN\s+visa|F-?1|OPT|CPT|EAD|green\s+card|permanent\s+residen(?:t|cy)|citizenship|citizens?|U\.?\s*S\.?\s+nationals?|U\.?\s*S\.?\s+persons?|foreign\s+nationals?|international\s+(?:applicants?|candidates?)|nonimmigrants?|ITAR|EAR|export\s+(?:controls?|regulations?|authori[sz]ations?)|clearance|department\s+of\s+state|refugees?|asylees?)\b/gi;
  const STRONG_SIGNAL_PATTERN = /\b(?:sponsor(?:ed|ing|ship)?|visa(?:s)?|H-?1B|O-?1|E-?3|TN\s+visa|F-?1|OPT|CPT)\b/i;
  const MAX_WINDOW_LENGTH = 560;
  const DEFAULT_MAX_WINDOWS = 12;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function hashValue(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function isBoundaryAt(text, index) {
    const character = text[index];
    if (/\n|•|[!?。！？]/.test(character)) return true;
    if (character !== ".") return false;

    const previous = text[index - 1] || "";
    const next = text[index + 1] || "";
    if (/[A-Za-z0-9]/.test(previous) && /[A-Za-z0-9]/.test(next)) {
      return false;
    }
    const prefix = text.slice(Math.max(0, index - 12), index + 1);
    if (/(?:\b[A-Za-z]\.){2,}$/.test(prefix)) return false;
    return true;
  }

  function findLeftBoundary(text, signalIndex) {
    const minimum = Math.max(0, signalIndex - 240);
    for (let index = signalIndex - 1; index >= minimum; index -= 1) {
      if (isBoundaryAt(text, index)) return index + 1;
    }
    return minimum;
  }

  function findRightBoundary(text, signalEnd) {
    const maximum = Math.min(text.length, signalEnd + 320);
    for (let index = signalEnd; index < maximum; index += 1) {
      if (isBoundaryAt(text, index)) return index + 1;
    }
    return maximum;
  }

  function trimWindow(text, start, end) {
    let nextStart = start;
    let nextEnd = end;
    while (nextStart < nextEnd && /\s/.test(text[nextStart])) nextStart += 1;
    while (nextEnd > nextStart && /\s/.test(text[nextEnd - 1])) nextEnd -= 1;
    if (nextEnd - nextStart > MAX_WINDOW_LENGTH) {
      nextEnd = nextStart + MAX_WINDOW_LENGTH;
    }
    return {
      start: nextStart,
      end: nextEnd,
      text: text.slice(nextStart, nextEnd)
    };
  }

  function scoreWindow(window) {
    let score = STRONG_SIGNAL_PATTERN.test(window.text) ? 3 : 1;
    if (/\b(?:without|not|no|only|must|required|available|provide|offer)\b/i.test(window.text)) {
      score += 1;
    }
    if (/\b(?:sponsor(?:ship)?|visa)\b/i.test(window.signal)) score += 1;
    return score;
  }

  function extractCandidateWindows(rawText, options) {
    const text = normalizeText(rawText);
    const maximum = Math.max(
      1,
      Number((options && options.maxWindows) || DEFAULT_MAX_WINDOWS)
    );
    const candidates = [];
    const regex = new RegExp(SIGNAL_PATTERN.source, SIGNAL_PATTERN.flags);
    let match;

    while ((match = regex.exec(text)) !== null) {
      const window = trimWindow(
        text,
        findLeftBoundary(text, match.index),
        findRightBoundary(text, match.index + match[0].length)
      );
      if (!window.text) continue;

      const overlapping = candidates.find((candidate) => {
        const overlapStart = Math.max(candidate.index, window.start);
        const overlapEnd = Math.min(candidate.end, window.end);
        const overlap = Math.max(0, overlapEnd - overlapStart);
        const shorter = Math.min(
          candidate.end - candidate.index,
          window.end - window.start
        );
        return shorter > 0 && overlap / shorter >= 0.72;
      });

      if (overlapping) {
        if (!overlapping.signals.includes(match[0])) {
          overlapping.signals.push(match[0]);
        }
        overlapping.signalSpans.push({
          start: match.index,
          end: match.index + match[0].length,
          text: match[0]
        });
        continue;
      }

      candidates.push({
        id: `window:${window.start}:${hashValue(window.text)}`,
        text: window.text,
        index: window.start,
        end: window.end,
        focusIndex: match.index,
        focusEnd: match.index + match[0].length,
        signal: match[0],
        signals: [match[0]],
        signalSpans: [{
          start: match.index,
          end: match.index + match[0].length,
          text: match[0]
        }]
      });
    }

    return candidates
      .map((candidate) => ({
        ...candidate,
        priority: scoreWindow(candidate)
      }))
      .sort((left, right) => {
        if (left.priority !== right.priority) return right.priority - left.priority;
        return left.index - right.index;
      })
      .slice(0, maximum)
      .map(({ priority, ...candidate }) => candidate);
  }

  function shouldRun(baseResult, settings, context) {
    if (!settings || !settings.localModelEnabled) return false;
    if (!baseResult || !baseResult.isLikelyJobPage) return false;
    if (baseResult.scanMode !== "job") return false;
    if (baseResult.status !== "unknown" && baseResult.status !== "review") {
      return false;
    }
    if (context && context.isApplicationFlow) return false;
    return true;
  }

  function getPredictionScore(prediction) {
    const score = Number(prediction && prediction.score);
    return Number.isFinite(score) ? score : 0;
  }

  function meetsThreshold(prediction, thresholds) {
    if (!prediction || !WINDOW_LABELS.has(prediction.label)) return false;
    const rawThreshold = thresholds && thresholds[prediction.label];
    if (typeof rawThreshold !== "number") return false;
    const threshold = Number(rawThreshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      return false;
    }
    return getPredictionScore(prediction) >= threshold;
  }

  function createModelEvidence(candidate, prediction, modelVersion, sequence) {
    const category = prediction.label;
    const matchedText = candidate.text;
    const title = category === "no"
      ? "Local model found a sponsorship restriction"
      : category === "yes"
        ? "Local model found sponsorship support"
        : category === "conditional"
          ? "Local model found a sponsorship condition"
          : "Local model found eligibility language to review";
    return {
      id: `ml:${modelVersion}:${candidate.id}:${sequence}`,
      ruleId: "local_model",
      source: "local-model",
      category,
      confidence: "high",
      score: getPredictionScore(prediction),
      title,
      matchedText,
      snippet: candidate.text,
      index: candidate.index
    };
  }

  function countEvidence(evidence) {
    return evidence.reduce(
      (counts, item) => {
        if (Object.hasOwn(counts, item.category)) counts[item.category] += 1;
        return counts;
      },
      { no: 0, conditional: 0, yes: 0, review: 0 }
    );
  }

  function mergePredictions(baseResult, candidates, predictions, artifact) {
    const result = {
      ...baseResult,
      evidence: Array.isArray(baseResult && baseResult.evidence)
        ? baseResult.evidence.slice()
        : []
    };
    if (
      result.status !== "unknown" &&
      result.status !== "review"
    ) {
      return result;
    }
    const modelVersion = String((artifact && artifact.version) || "unknown");
    const thresholds = artifact && artifact.thresholds;
    const candidateById = new Map(
      (Array.isArray(candidates) ? candidates : []).map((candidate) => [
        candidate.id,
        candidate
      ])
    );
    const accepted = (Array.isArray(predictions) ? predictions : [])
      .filter((prediction) => {
        return candidateById.has(prediction.windowId) &&
          prediction.label !== "irrelevant" &&
          meetsThreshold(prediction, thresholds);
      })
      .sort((left, right) => getPredictionScore(right) - getPredictionScore(left));

    result.model = {
      source: "local",
      policyVersion: VERSION,
      version: modelVersion,
      state: accepted.length ? "completed" : "no-decision"
    };

    if (!accepted.length) return result;

    const decisiveCategories = new Set(
      accepted
        .map((prediction) => prediction.label)
        .filter((label) => DECISIVE_LABELS.has(label))
    );
    if (decisiveCategories.size > 1) {
      result.model.state = "conflict";
      const conflictPredictions = [];
      decisiveCategories.forEach((category) => {
        const prediction = accepted.find((item) => item.label === category);
        if (prediction) conflictPredictions.push(prediction);
      });
      conflictPredictions.forEach((prediction, sequence) => {
        result.evidence.push(createModelEvidence(
          candidateById.get(prediction.windowId),
          prediction,
          modelVersion,
          result.evidence.length + sequence
        ));
      });
      result.evidence.sort((left, right) => left.index - right.index);
      result.counts = countEvidence(result.evidence);
      result.analysisSource = "rules+local-model";
      if (result.status === "unknown") {
        const meta = STATUS_META.review;
        result.status = "review";
        result.label = meta.label;
        result.shortLabel = meta.shortLabel;
        result.color = meta.color;
      }
      result.summary = "The local model found conflicting sponsorship language. Review the listing evidence.";
      return result;
    }

    const selected = accepted.find((prediction) => {
      return DECISIVE_LABELS.has(prediction.label);
    }) || accepted[0];
    const candidate = candidateById.get(selected.windowId);
    const nextStatus = selected.label;
    if (!STATUS_META[nextStatus]) return result;

    const evidence = createModelEvidence(
      candidate,
      selected,
      modelVersion,
      result.evidence.length
    );
    result.evidence.push(evidence);
    result.evidence.sort((left, right) => left.index - right.index);
    result.counts = countEvidence(result.evidence);

    if (
      result.status === "unknown" ||
      (result.status === "review" && DECISIVE_LABELS.has(nextStatus))
    ) {
      const meta = STATUS_META[nextStatus];
      result.status = nextStatus;
      result.label = meta.label;
      result.shortLabel = meta.shortLabel;
      result.summary = meta.summary;
      result.color = meta.color;
    }
    result.analysisSource = "rules+local-model";
    return result;
  }

  return {
    VERSION,
    WINDOW_LABELS: Array.from(WINDOW_LABELS),
    normalizeText,
    extractCandidateWindows,
    shouldRun,
    mergePredictions
  };
});
