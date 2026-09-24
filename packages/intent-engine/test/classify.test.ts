import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicaliseUrl,
  classify,
  domainOf,
  expandBang,
  normaliseQuery,
} from "../src/classify.ts";

describe("classify", () => {
  it("treats an explicit URL as a destination", () => {
    const result = classify("https://example.com/path?a=1");
    assert.equal(result.kind, "url");
    assert.equal(result.kind === "url" && result.url, "https://example.com/path?a=1");
  });

  it("treats a bare domain as a destination and adds https", () => {
    const result = classify("figma.com");
    assert.equal(result.kind, "url");
    assert.equal(result.kind === "url" && result.url, "https://figma.com");
  });

  it("handles localhost and IPs with ports", () => {
    for (const input of ["localhost:3000", "127.0.0.1:8080/admin", "192.168.1.5"]) {
      assert.equal(classify(input).kind, "url", input);
    }
  });

  it("does not mistake a comparison query for a domain", () => {
    const result = classify("apple.com vs samsung.com");
    assert.equal(result.kind, "search");
  });

  it("does not mistake a file-ish word for a domain", () => {
    // Two-letter-minimum TLD rule keeps these out.
    assert.equal(classify("what is node.js").kind, "search");
    assert.equal(classify("3.14").kind, "search");
  });

  it("rejects dangerous schemes instead of navigating to them", () => {
    assert.equal(classify("javascript:alert(1)").kind, "search");
    assert.equal(classify("data:text/html,<script>").kind, "search");
  });

  it("expands leading and trailing bangs", () => {
    const leading = classify("!w tardigrade");
    assert.equal(leading.kind, "bang");
    assert.ok(leading.kind === "bang" && leading.url.includes("wikipedia.org"));
    assert.ok(leading.kind === "bang" && leading.url.includes("tardigrade"));

    const trailing = classify("tardigrade !w");
    assert.equal(trailing.kind, "bang");
    assert.equal(trailing.kind === "bang" && trailing.rest, "tardigrade");
  });

  it("sends a bare bang to the site root rather than an empty search", () => {
    const result = classify("!gh");
    assert.equal(result.kind, "bang");
    assert.equal(result.kind === "bang" && result.url, "https://github.com/");
  });

  it("translates natural language into the same bang", () => {
    const natural = classify("wikipedia for tardigrades");
    const explicit = classify("!w tardigrades");
    assert.equal(natural.kind, "bang");
    assert.equal(
      natural.kind === "bang" ? natural.url : "",
      explicit.kind === "bang" ? explicit.url : "x",
    );
  });

  it("recognises the trailing natural form too", () => {
    const result = classify("rust lifetimes on reddit");
    assert.equal(result.kind, "bang");
    assert.equal(result.kind === "bang" && result.bang, "r");
    assert.equal(result.kind === "bang" && result.rest, "rust lifetimes");
  });

  it("ignores an unknown bang and searches instead", () => {
    assert.equal(classify("!zzz something").kind, "search");
  });

  it("leaves plain intent alone", () => {
    const result = classify("cheap flights Berlin to Lisbon");
    assert.equal(result.kind, "search");
    assert.equal(result.kind === "search" && result.query, "cheap flights Berlin to Lisbon");
  });
});

describe("expandBang", () => {
  it("URL-encodes the remainder", () => {
    const url = expandBang("gh", "a b&c");
    assert.ok(url.includes("a%20b%26c"));
  });

  it("throws on an unknown bang", () => {
    assert.throws(() => expandBang("nope", "x"), /unknown bang/);
  });
});

describe("canonicaliseUrl", () => {
  it("collapses the variants of one page into one key", () => {
    const variants = [
      "https://www.Example.com/post/",
      "http://example.com/post?utm_source=x",
      "https://example.com/post#section",
    ];
    const keys = new Set(variants.map(canonicaliseUrl));
    assert.equal(keys.size, 1, [...keys].join(" | "));
  });

  it("keeps meaningful query parameters and sorts them", () => {
    assert.equal(canonicaliseUrl("https://x.com/a?b=2&a=1"), "x.com/a?a=1&b=2");
  });

  it("keeps a non-default port", () => {
    assert.equal(canonicaliseUrl("http://localhost:3000/x"), "localhost:3000/x");
  });
});

describe("domainOf", () => {
  it("strips www and lowercases", () => {
    assert.equal(domainOf("https://WWW.Example.COM/a"), "example.com");
  });

  it("returns empty for garbage rather than throwing", () => {
    assert.equal(domainOf("not a url"), "");
  });
});

describe("normaliseQuery", () => {
  it("makes equivalent phrasings share a cache key", () => {
    assert.equal(normaliseQuery("  Café  RESTAURANTS!! "), "cafe restaurants");
  });

  it("preserves non-Latin scripts", () => {
    assert.equal(normaliseQuery("日本語 検索"), "日本語 検索");
  });
});
