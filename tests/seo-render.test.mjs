import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAppServer } from "../server.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the initial page HTML includes archived draws and frequency values without running browser JavaScript", async () => {
  const server = createAppServer({ root: projectRoot, resultsService: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const html = await response.text();
    const robotsResponse = await fetch(`http://127.0.0.1:${address.port}/robots.txt`);
    const robots = await robotsResponse.text();
    const sitemapResponse = await fetch(`http://127.0.0.1:${address.port}/sitemap.xml`);
    const sitemap = await sitemapResponse.text();

    assert.equal(response.status, 200);
    assert.match(html, /<title>Malta Super5 Results &amp; History \| Frequencies &amp; Picks<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/super5malta\.onrender\.com\/">/);
    assert.match(html, /id="latest-draw-number">393<\/strong>/);
    assert.match(html, /id="latest-draw-balls"><span class="mini-ball">2<\/span><span class="mini-ball">5<\/span><span class="mini-ball">9<\/span><span class="mini-ball">16<\/span><span class="mini-ball">26<\/span><\/div>/);
    assert.match(html, /id="recent-draws">[\s\S]*?NO\. 393[\s\S]*?NO\. 392/);
    assert.match(html, /id="recent-frequency-summary">Current format frequency leaders \(draw count\):/);
    assert.equal((html.match(/class="frequency-cell/g) || []).length, 49);
    assert.match(html, /class="frequency-cell[^\"]*" title="Number 1: drawn \d+ times in this era"/);
    assert.match(html, /id="archive-list">[\s\S]*?NO\. 393[\s\S]*?NO\. 392/);
    assert.doesNotMatch(html, /SSR_[A-Z_]+/);
    assert.equal(robotsResponse.status, 200);
    assert.match(robots, /^Sitemap: https:\/\/super5malta\.onrender\.com\/sitemap\.xml$/m);
    assert.equal(sitemapResponse.status, 200);
    assert.match(sitemapResponse.headers.get("content-type"), /application\/xml/);
    assert.match(sitemap, /<loc>https:\/\/super5malta\.onrender\.com\/<\/loc>/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
