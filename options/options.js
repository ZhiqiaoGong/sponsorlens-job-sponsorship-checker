"use strict";

const DEFAULT_SETTINGS = {
  pageIndicator: true,
  autoRescan: true,
  enableBadge: true,
  showUnknownOnJobPages: true,
  customNoPhrases: [],
  customYesPhrases: []
};

const ids = [
  "pageIndicator",
  "autoRescan",
  "enableBadge",
  "showUnknownOnJobPages"
];

function parsePhrases(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 100);
}

function loadSettings() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    ids.forEach((id) => {
      document.getElementById(id).checked = Boolean(settings[id]);
    });
    document.getElementById("customNoPhrases").value =
      (settings.customNoPhrases || []).join("\n");
    document.getElementById("customYesPhrases").value =
      (settings.customYesPhrases || []).join("\n");
  });
}

function saveSettings() {
  const settings = {};
  ids.forEach((id) => {
    settings[id] = document.getElementById(id).checked;
  });
  settings.customNoPhrases = parsePhrases(
    document.getElementById("customNoPhrases").value
  );
  settings.customYesPhrases = parsePhrases(
    document.getElementById("customYesPhrases").value
  );

  chrome.storage.sync.set(settings, () => {
    const status = document.getElementById("saveStatus");
    status.textContent = "Saved";
    setTimeout(() => {
      status.textContent = "";
    }, 1800);
  });
}

document.getElementById("saveButton").addEventListener("click", saveSettings);
loadSettings();
