"use strict";

const DEFAULT_SETTINGS = {
  pageIndicator: true,
  autoRescan: true,
  enableBadge: true,
  showUnknownOnJobPages: true,
  customNoPhrases: [],
  customYesPhrases: []
};

const BADGES = {
  no: { text: "NO", color: "#dc2626", title: "SponsorLens: sponsorship is not available" },
  conditional: { text: "?", color: "#d97706", title: "SponsorLens: sponsorship is conditional" },
  yes: { text: "YES", color: "#15803d", title: "SponsorLens: sponsorship is available" },
  review: { text: "?", color: "#ca8a04", title: "SponsorLens: eligibility requirements need review" },
  unknown: { text: "", color: "#64748b", title: "SponsorLens: sponsorship is not mentioned" }
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    chrome.storage.sync.set(settings);
  });
});

function updateBadge(tabId, result) {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    const badge = BADGES[result.status] || BADGES.unknown;
    const text = settings.enableBadge ? badge.text : "";
    chrome.action.setBadgeText({ tabId, text });
    chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
    chrome.action.setTitle({ tabId, title: badge.title });
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message && message.type === "SPONSORLENS_RESULT" && sender.tab && sender.tab.id) {
    updateBadge(sender.tab.id, message.result);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes.enableBadge) return;
  if (!changes.enableBadge.newValue) {
    chrome.action.setBadgeText({ text: "" });
  }
});
