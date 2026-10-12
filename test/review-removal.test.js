import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("review and format migration features are absent while compile diagnosis remains", async () => {
  const [indexHtml, appJs, serverJs] = await Promise.all([
    fs.readFile(path.join(process.cwd(), "public", "index.html"), "utf8"),
    fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8"),
    fs.readFile(path.join(process.cwd(), "server.js"), "utf8")
  ]);

  assert.doesNotMatch(indexHtml, /data-mode="review"|id="reviewView"|id="runReviewButton"|testReviewButton/);
  assert.doesNotMatch(indexHtml, /id="formatView"|formatPreflightDialog|data-provider="format"|testFormatButton/);
  assert.doesNotMatch(appJs, /\/api\/review|runReview|loadReview|renderReview/);
  assert.doesNotMatch(appJs, /\/api\/format|analyzeTargetFormat|applyTargetFormat|formatPreflight/);
  assert.doesNotMatch(serverJs, /app\.(?:get|post)\("\/api\/review/);
  assert.doesNotMatch(serverJs, /app\.(?:get|post)\("\/api\/format/);
  assert.match(indexHtml, /data-provider="diagnosis"/);
  assert.match(serverJs, /config\.diagnosis/);
});
