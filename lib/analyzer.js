(function sponsorLensAnalyzerFactory(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.SponsorLensAnalyzer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createAnalyzer() {
  "use strict";

  const VERSION = "0.2.0";
  const MAX_TEXT_LENGTH = 800000;
  const MAX_EVIDENCE = 12;

  const STATUS = {
    no: {
      label: "No sponsorship",
      shortLabel: "No Sponsor",
      summary: "Explicit no-sponsorship language or an eligibility restriction was found.",
      color: "#dc2626"
    },
    conditional: {
      label: "Conditional sponsorship",
      shortLabel: "Conditional",
      summary: "Sponsorship may depend on seniority, visa type, or other conditions.",
      color: "#d97706"
    },
    yes: {
      label: "Sponsorship available",
      shortLabel: "Sponsor",
      summary: "Explicit language offering sponsorship or visa support was found.",
      color: "#15803d"
    },
    review: {
      label: "Needs review",
      shortLabel: "Review",
      summary: "A work authorization, export control, or clearance requirement was found, but it does not determine sponsorship.",
      color: "#ca8a04"
    },
    unknown: {
      label: "Not mentioned",
      shortLabel: "Not mentioned",
      summary: "No clear sponsorship information was found on this page.",
      color: "#64748b"
    }
  };

  const RULES = [
    {
      id: "no_action_sponsorship",
      category: "no",
      confidence: "high",
      title: "Employer explicitly does not provide sponsorship",
      pattern: /\b(?:do(?:es)?\s+not|don['’]t|doesn['’]t|will\s+not|won['’]t|can(?:not|['’]t)|unable\s+to|not\s+able\s+to)\s+(?:be\s+)?(?:provide|providing|offer|offering|support|supporting|facilitate|facilitating|assume|assuming|take\s+over|taking\s+over)(?:\s+[a-z-]+){0,6}\s+(?:visa|immigration|employment|work(?:\s+visa)?)?\s*sponsorship\b/gi
    },
    {
      id: "no_sponsor_candidates",
      category: "no",
      confidence: "high",
      title: "Employer will not sponsor candidates",
      pattern: /\b(?:do(?:es)?\s+not|will\s+not|can(?:not|['’]t)|unable\s+to|not\s+able\s+to)\s+sponsor\b(?:\s+(?:applicants?|candidates?|employees?|individuals?|work\s+visas?)){0,2}/gi
    },
    {
      id: "sponsorship_not_available",
      category: "no",
      confidence: "high",
      title: "Sponsorship is not available",
      pattern: /\b(?:visa|employment|immigration|work(?:\s+visa)?)?\s*sponsorship\s+(?:(?:is|will\s+be|can\s+be)\s+)?not\s+(?:currently\s+)?(?:available|offered|provided|supported|permitted)\b/gi
    },
    {
      id: "sponsorship_cannot_be_provided",
      category: "no",
      confidence: "high",
      title: "Sponsorship cannot be provided",
      pattern: /\b(?:visa|employment|immigration)?\s*sponsorship\b.{0,22}\b(?:cannot|can['’]t|will\s+not|won['’]t)\s+be\s+(?:provided|offered|supported|facilitated)\b/gi
    },
    {
      id: "no_sponsorship_phrase",
      category: "no",
      confidence: "high",
      title: "Explicit no-sponsorship statement",
      pattern: /\bno\s+(?:visa|employment|immigration|work(?:\s+visa)?)\s+sponsorship\b/gi
    },
    {
      id: "not_eligible_sponsorship",
      category: "no",
      confidence: "high",
      title: "Role is not eligible for sponsorship",
      pattern: /\bnot\s+eligible\s+for(?:\s+[a-z-]+){0,4}\s+(?:visa|immigration|employment)?\s*sponsorship\b/gi
    },
    {
      id: "without_sponsorship_future",
      category: "no",
      confidence: "high",
      title: "Must not need sponsorship now or in the future",
      pattern: /\b(?:authorized|eligible|permitted)\s+to\s+work\b.{0,120}\bwithout\b.{0,45}\bsponsorship\b|\bwithout\b.{0,45}\bsponsorship\b.{0,120}\b(?:now|currently)\b.{0,35}\b(?:future|later)\b/gi
    },
    {
      id: "must_not_require_sponsorship",
      category: "no",
      confidence: "high",
      title: "Candidates must not require sponsorship",
      pattern: /\b(?:must|should|will|do)\s+not\b.{0,45}\brequire\b.{0,45}\bsponsorship\b|\bmust\b.{0,35}\bnot\s+require\b.{0,45}\bsponsorship\b/gi
    },
    {
      id: "sponsored_candidates_not_considered",
      category: "no",
      confidence: "high",
      title: "Candidates requiring sponsorship will not be considered",
      pattern: /\b(?:not|no\s+longer)\s+(?:considering|accepting)\b.{0,80}\b(?:applicants?|candidates?)\b.{0,80}\b(?:require|need)\b.{0,45}\bsponsorship\b|\b(?:applicants?|candidates?)\b.{0,60}\b(?:requiring|who\s+require|that\s+require)\b.{0,45}\bsponsorship\b.{0,60}\b(?:will\s+not|won['’]t|cannot|can['’]t)\s+be\s+considered\b/gi
    },
    {
      id: "no_sponsorship_available",
      category: "no",
      confidence: "high",
      title: "No sponsorship is available",
      pattern: /\bno\b.{0,35}\bsponsorship\b.{0,18}\b(?:available|provided|offered|supported)\b/gi
    },
    {
      id: "citizenship_no_exceptions",
      category: "no",
      confidence: "high",
      title: "U.S. citizenship is required with no exceptions",
      pattern: /\b(?:U\.?\s*S\.?|United\s+States)\s+citizenship\b[^\n.!?]{0,140}\b(?:no\s+exceptions?|without\s+exception|(?:green\s+card\s+holders?|(?:lawful\s+)?permanent\s+residents?)\s+(?:are\s+)?not\s+(?:eligible|accepted|permitted|considered))\b(?:\s*\))?/gi
    },
    {
      id: "citizenship_required",
      category: "no",
      confidence: "high",
      title: "U.S. citizenship is required",
      pattern: /\b(?:(?:U\.?\s*S\.?|United\s+States)\s+citizenship\s+(?:is\s+)?required|must\s+be\s+(?:an?\s+)?(?:U\.?\s*S\.?|United\s+States)\s+citizen|(?:U\.?\s*S\.?|United\s+States)\s+citizens?\s+only|(?:U\.?\s*S\.?|United\s+States)\s+citizens?(?:\s+or\s+(?:green\s+card\s+holders?|permanent\s+residents?))?\s+(?:are\s+)?required)\b/gi
    },
    {
      id: "citizen_resident_only",
      category: "no",
      confidence: "high",
      title: "Limited to citizens or permanent residents",
      pattern: /\b(?:only|limited\s+to)\s+(?:(?:U\.?\s*S\.?|United\s+States)\s+)?citizens?(?:\s+(?:or|and)\s+(?:lawful\s+)?permanent\s+residents?)?\b|\b(?:U\.?\s*S\.?\s+citizens?\s+(?:or|and)\s+)?(?:green\s+card\s+holders?|(?:lawful\s+)?permanent\s+residents?)\s+only\b|\b(?:requires?|requiring|must\s+have)\s+(?:either\s+)?(?:U\.?\s*S\.?|United\s+States)\s+citizenship\s+(?:or|and)\s+(?:a\s+)?(?:green\s+card\s+holders?|(?:lawful\s+)?permanent\s+residen(?:t|cy))\b/gi
    },
    {
      id: "conditional_only",
      category: "conditional",
      confidence: "medium",
      title: "Sponsorship is available only under specific conditions",
      pattern: /\bsponsorship\b.{0,110}\b(?:only|solely|case[- ]by[- ]case|depending\s+on|limited\s+to|select|certain|eligible\s+(?:roles?|candidates?)|specific\s+(?:roles?|levels?))\b|\b(?:only|select|certain|some|eligible|specific)\b.{0,110}\bsponsorship\b/gi
    },
    {
      id: "conditional_may",
      category: "conditional",
      confidence: "medium",
      title: "Sponsorship availability requires confirmation",
      pattern: /\b(?:may|might|could)\s+(?:be\s+able\s+to\s+)?(?:provide|offer|support|consider|sponsor)\b.{0,80}\b(?:visa|immigration|employment|sponsorship|candidates?)\b|\bsponsorship\s+(?:may|might|could)\s+be\s+(?:available|considered|offered|provided)\b|\blimited\s+(?:visa\s+|employment\s+)?sponsorship\b/gi
    },
    {
      id: "conditional_level",
      category: "conditional",
      confidence: "medium",
      title: "Sponsorship depends on level or seniority",
      pattern: /\b(?:sponsor(?:ship)?|H-?1B|work\s+visa)\b.{0,130}\b(?:level|grade|seniority|years?\s+of\s+experience)\b.{0,55}\b(?:above|below|higher|lower|minimum|maximum|L\d|IC\d|level\s+\d)\b|\b(?:level|grade|seniority|L\d|IC\d)\b.{0,100}\b(?:sponsor(?:ship)?|H-?1B|work\s+visa)\b/gi
    },
    {
      id: "conditional_transfer_only",
      category: "conditional",
      confidence: "medium",
      title: "Only specific visa types or transfers are supported",
      pattern: /\b(?:H-?1B|visa)\s+transfers?\s+only\b|\bonly\s+(?:support|sponsor|accept)\b.{0,45}\b(?:H-?1B|O-?1|TN|E-?3|visa\s+transfers?)\b/gi
    },
    {
      id: "conditional_visa_type_restriction",
      category: "conditional",
      confidence: "medium",
      title: "A specific visa type is not accepted or supported",
      pattern: /\b(?:do(?:es)?\s+not|not\s+able\s+to|unable\s+to|cannot|can['’]t)\s+(?:accept|support|consider)\b.{0,55}\b(?:F-?1|OPT|CPT|H-?1B|O-?1|TN|E-?3|visa\s+transfers?)\b/gi
    },
    {
      id: "sponsorship_available",
      category: "yes",
      confidence: "high",
      title: "Sponsorship is explicitly available",
      pattern: /\b(?:visa|employment|immigration|work(?:\s+visa)?)?\s*sponsorship\s+(?:(?:is|will\s+be)\s+)?(?:available|offered|provided|supported)\b/gi
    },
    {
      id: "company_offers_sponsorship",
      category: "yes",
      confidence: "high",
      title: "Employer offers sponsorship",
      pattern: /\b(?:we|the\s+company|the\s+employer)\s+(?:do\s+)?(?:provide|offer|support)\s+(?:qualified\s+candidates?\s+with\s+)?(?:visa|employment|immigration|work(?:\s+visa)?)?\s*sponsorship\b/gi
    },
    {
      id: "company_sponsors_visas",
      category: "yes",
      confidence: "high",
      title: "Employer sponsors visas or candidates",
      pattern: /\bwe\s+(?:(?:will|can)\s+|are\s+able\s+to\s+)?sponsor\b.{0,80}\b(?:visas?|H-?1B|O-?1|qualified\s+(?:applicants?|candidates?)|employees?)\b/gi
    },
    {
      id: "visa_transfer_supported",
      category: "yes",
      confidence: "medium",
      title: "Visa sponsorship or transfers are supported",
      pattern: /\b(?:H-?1B|O-?1|TN|E-?3)\s+(?:visa\s+)?(?:sponsorship|transfers?)\s+(?:(?:is|are)\s+)?(?:available|supported|offered|welcome)\b/gi
    },
    {
      id: "current_authorization",
      category: "review",
      confidence: "medium",
      title: "U.S. work authorization is required",
      pattern: /\bmust\s+(?:be|have)\s+(?:currently\s+)?(?:legally\s+)?(?:authorized|authorization)\s+to\s+work\s+in\s+(?:the\s+)?(?:U\.?\s*S\.?|United\s+States)\b|\b(?:legally\s+)?authorized\s+to\s+work\s+in\s+(?:the\s+)?(?:U\.?\s*S\.?|United\s+States)\s+(?:is\s+)?required\b/gi
    },
    {
      id: "us_person_export",
      category: "review",
      confidence: "medium",
      title: "U.S. person or export control requirement",
      pattern: /\b(?:U\.?\s*S\.?|United\s+States)\s+persons?\b.{0,100}\b(?:export|ITAR|EAR|control(?:led)?)\b|\b(?:export|ITAR|EAR)\b.{0,100}\b(?:U\.?\s*S\.?|United\s+States)\s+persons?\b|\bmust\s+be\s+(?:an?\s+)?(?:U\.?\s*S\.?|United\s+States)\s+person\b|\b(?:U\.?\s*S\.?|United\s+States)\s+government\s+export\s+regulations?\b[\s\S]{0,900}?\beligible\s+to\s+obtain\s+(?:the\s+)?required\s+authorizations?\s+from\s+(?:the\s+)?(?:U\.?\s*S\.?|United\s+States)\s+department\s+of\s+state\b/gi
    },
    {
      id: "clearance_requirement",
      category: "review",
      confidence: "medium",
      title: "Security clearance requirement",
      pattern: /\b(?:must\s+(?:hold|have|obtain)|ability\s+to\s+obtain|eligible\s+for)\b.{0,65}\b(?:security|government)\s+clearance\b|\bmust\s+be\s+eligible\s+for\s+(?:an?\s+)?clearance\b|\b(?:active\s+)?(?:secret|top\s+secret|TS\/SCI|security)\s+clearance\s+(?:is\s+)?required\b/gi
    }
  ];

  const CATEGORY_ORDER = {
    no: 0,
    conditional: 1,
    yes: 2,
    review: 3
  };

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function truncate(value, maxLength) {
    const text = String(value || "");
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
  }

  function getSnippet(text, index, matchLength) {
    const leftLimit = Math.max(0, index - 220);
    const rightLimit = Math.min(text.length, index + matchLength + 280);
    const leftSlice = text.slice(leftLimit, index);
    const rightSlice = text.slice(index + matchLength, rightLimit);
    const boundaryPattern = /[.!?。！？\n•]/g;

    let start = leftLimit;
    let leftMatch;
    while ((leftMatch = boundaryPattern.exec(leftSlice)) !== null) {
      start = leftLimit + leftMatch.index + 1;
    }

    boundaryPattern.lastIndex = 0;
    const rightMatch = boundaryPattern.exec(rightSlice);
    const end = rightMatch
      ? index + matchLength + rightMatch.index + 1
      : rightLimit;

    let snippet = normalizeText(text.slice(start, end));
    if (snippet.length < 45) {
      snippet = normalizeText(text.slice(leftLimit, rightLimit));
    }
    return truncate(snippet, 420);
  }

  function createEvidence(rule, match, text, sequence) {
    const snippet = getSnippet(text, match.index, match[0].length);
    const hasLevelCondition =
      /\b(?:sponsor|sponsorship|H-?1B|work\s+visa)\b.{0,180}\b(?:below|above|under|over|lower|higher)\b.{0,45}\b(?:level|grade|L\d|IC\d|director|manager|staff|senior)\b/i.test(snippet) ||
      /\b(?:below|above|under|over|lower|higher)\b.{0,45}\b(?:level|grade|L\d|IC\d|director|manager|staff|senior)\b.{0,180}\b(?:sponsor|sponsorship|H-?1B|work\s+visa)\b/i.test(snippet);
    const category = rule.category === "no" && hasLevelCondition
      ? "conditional"
      : rule.category;
    return {
      id: `${rule.id}:${sequence}`,
      ruleId: rule.id,
      category,
      confidence: rule.confidence,
      title: category === "conditional" && rule.category === "no"
        ? "Sponsorship depends on level or seniority"
        : rule.title,
      matchedText: truncate(normalizeText(match[0]), 220),
      snippet,
      index: match.index
    };
  }

  function runRule(rule, text, evidence, seen) {
    const flags = rule.pattern.flags.includes("g")
      ? rule.pattern.flags
      : `${rule.pattern.flags}g`;
    const regex = new RegExp(rule.pattern.source, flags);
    let match;
    let sequence = 0;

    while ((match = regex.exec(text)) !== null && sequence < 8) {
      const item = createEvidence(rule, match, text, sequence);
      const dedupeKey = `${rule.category}:${item.matchedText.toLowerCase()}`;
      if (!seen.has(dedupeKey)) {
        evidence.push(item);
        seen.add(dedupeKey);
      }
      sequence += 1;
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  }

  function addCustomPhraseEvidence(category, phrases, text, evidence, seen) {
    (Array.isArray(phrases) ? phrases : []).forEach(function addPhrase(phrase, phraseIndex) {
      const cleanPhrase = normalizeText(phrase);
      if (cleanPhrase.length < 3) return;
      const rule = {
        id: `custom_${category}_${phraseIndex}`,
        category,
        confidence: "high",
        title: category === "no"
          ? "Matched a custom no-sponsorship phrase"
          : "Matched a custom sponsorship phrase",
        pattern: new RegExp(escapeRegExp(cleanPhrase), "gi")
      };
      runRule(rule, text, evidence, seen);
    });
  }

  function assessJobLikelihood(text, meta) {
    const url = String((meta && meta.url) || "").toLowerCase();
    const title = String((meta && meta.title) || "").toLowerCase();
    const sample = text.slice(0, 120000).toLowerCase();
    let score = 0;

    if (/(?:\/jobs?\/|\/careers?\/|jobid=|job_id=|viewjob|requisition|myworkdayjobs|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters|linkedin\.com\/jobs)/.test(url)) {
      score += 2;
    }
    if (/\b(?:job|career|position|role|engineer|designer|manager|analyst|scientist)\b/.test(title)) {
      score += 1;
    }

    const signals = [
      /\bjob description\b/,
      /\bresponsibilities\b/,
      /\bqualifications\b/,
      /\bapply (?:now|for this job|for this position)\b/,
      /\babout (?:the|this) role\b/,
      /\bpreferred qualifications\b/,
      /\bminimum qualifications\b/
    ];
    const contentSignals = signals.reduce(function countSignals(total, pattern) {
      return total + (pattern.test(sample) ? 1 : 0);
    }, 0);
    score += Math.min(contentSignals, 3);

    return {
      score,
      isLikelyJobPage: score >= 2
    };
  }

  function resolveStatus(evidence) {
    if (evidence.some((item) => item.category === "no")) return "no";
    if (evidence.some((item) => item.category === "conditional")) return "conditional";
    if (evidence.some((item) => item.category === "yes")) return "yes";
    if (evidence.some((item) => item.category === "review")) return "review";
    return "unknown";
  }

  function analyze(rawText, meta, options) {
    const text = normalizeText(rawText).slice(0, MAX_TEXT_LENGTH);
    const evidence = [];
    const seen = new Set();
    const analysisOptions = options || {};
    const likelihood = assessJobLikelihood(text, meta || {});
    const skipRules =
      Boolean(analysisOptions.skipNonJob) && !likelihood.isLikelyJobPage;

    if (!skipRules) {
      RULES.forEach(function applyRule(rule) {
        runRule(rule, text, evidence, seen);
      });

      addCustomPhraseEvidence(
        "no",
        analysisOptions.customNoPhrases,
        text,
        evidence,
        seen
      );
      addCustomPhraseEvidence(
        "yes",
        analysisOptions.customYesPhrases,
        text,
        evidence,
        seen
      );
    }

    evidence.sort(function sortEvidence(a, b) {
      const categoryDelta = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
      if (categoryDelta !== 0) return categoryDelta;
      if (a.confidence !== b.confidence) return a.confidence === "high" ? -1 : 1;
      return a.index - b.index;
    });

    const status = resolveStatus(evidence);
    const counts = evidence.reduce(
      function countCategories(accumulator, item) {
        accumulator[item.category] += 1;
        return accumulator;
      },
      { no: 0, conditional: 0, yes: 0, review: 0 }
    );

    return {
      version: VERSION,
      status,
      label: STATUS[status].label,
      shortLabel: STATUS[status].shortLabel,
      summary: STATUS[status].summary,
      color: STATUS[status].color,
      evidence: evidence.slice(0, MAX_EVIDENCE),
      counts,
      textLength: text.length,
      truncated: normalizeText(rawText).length > MAX_TEXT_LENGTH,
      isLikelyJobPage: likelihood.isLikelyJobPage,
      jobLikelihoodScore: likelihood.score,
      scanMode: analysisOptions.pageWide
        ? "page"
        : skipRules
          ? "skipped"
          : likelihood.isLikelyJobPage
            ? "job"
            : "analysis",
      page: {
        url: String((meta && meta.url) || ""),
        title: String((meta && meta.title) || "")
      },
      detectedAt: Date.now()
    };
  }

  return {
    VERSION,
    STATUS,
    RULES,
    normalizeText,
    analyze,
    assessJobLikelihood
  };
});
