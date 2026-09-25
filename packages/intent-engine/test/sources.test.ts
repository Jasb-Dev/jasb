import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WikipediaSource } from "../src/sources/vertical.ts";

function recordingFetch(urls: string[]) {
  return async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ pages: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("WikipediaSource", () => {
  it("asks for two articles on a short query", async () => {
    const urls: string[] = [];
    await new WikipediaSource({ fetch: recordingFetch(urls) }).search({
      query: "tardigrade",
      limit: 6,
    } as never);
    assert.match(urls[0]!, /limit=2$/);
  });

  it("asks for one article on a sentence, so its words are not answered one by one", async () => {
    const urls: string[] = [];
    await new WikipediaSource({ fetch: recordingFetch(urls) }).search({
      query: "how do tardigrades survive vacuum",
      limit: 6,
    } as never);
    assert.match(urls[0]!, /limit=1$/);
    assert.ok(urls[0]!.includes(encodeURIComponent("how do tardigrades survive vacuum")));
  });
});
