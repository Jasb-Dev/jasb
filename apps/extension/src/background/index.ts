/**
 * The service worker.
 *
 * Two jobs:
 *
 *   1. **Omnibox keyword.** Typing `j ` in Chrome's address bar routes the rest
 *      of the input here. This is the lightweight entry point for people who do
 *      not want to hand over their default search engine — the roadmap's answer
 *      to "we cannot replace the address bar, so meet it where it is".
 *   2. **Suggestions.** As the user types we answer from their own bookmarks
 *      and history, locally and instantly, with no network call at all.
 */

import { classify } from "@jasb/intent-engine";

import { searchLocal } from "../shared/local.ts";

const NEW_TAB_URL = chrome.runtime.getURL("newtab.html");

chrome.omnibox.setDefaultSuggestion({
  description: "Find sites for <match>%s</match> — no chat, no agents, no ads",
});

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  const trimmed = text.trim();
  if (!trimmed) {
    suggest([]);
    return;
  }

  const classified = classify(trimmed);
  const suggestions: chrome.omnibox.SuggestResult[] = [];

  // A destination is a destination — say so before anything else.
  if (classified.kind === "url") {
    suggestions.push({
      content: classified.url,
      description: `Go to <url>${escapeXml(classified.url)}</url>`,
    });
  } else if (classified.kind === "bang") {
    suggestions.push({
      content: classified.url,
      description: `Jump: <match>!${escapeXml(classified.bang)}</match> <dim>${escapeXml(classified.rest)}</dim>`,
    });
  }

  // Then the user's own web, which costs nothing and is usually right.
  void searchLocal(trimmed, 4)
    .then((hits) => {
      for (const hit of hits) {
        suggestions.push({
          content: hit.url,
          description:
            `<dim>${hit.origin === "bookmark" ? "bookmark" : "visited"}</dim> ` +
            `${escapeXml(hit.title)} — <url>${escapeXml(hit.domain)}</url>`,
        });
      }
      suggest(suggestions.slice(0, 6));
    })
    .catch(() => suggest(suggestions.slice(0, 6)));
});

chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  const trimmed = text.trim();
  if (!trimmed) return;

  // A suggestion's `content` is already a URL; free text becomes a search.
  const target = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `${NEW_TAB_URL}?q=${encodeURIComponent(trimmed)}`;

  switch (disposition) {
    case "newForegroundTab":
      void chrome.tabs.create({ url: target });
      break;
    case "newBackgroundTab":
      void chrome.tabs.create({ url: target, active: false });
      break;
    default:
      void chrome.tabs.update({ url: target });
  }
});

/** Clicking the toolbar icon opens the new tab page, the product's front door. */
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: NEW_TAB_URL });
});

/**
 * Omnibox descriptions are parsed as XML, so an ampersand or angle bracket in a
 * page title breaks the whole suggestion list if it is not escaped.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
