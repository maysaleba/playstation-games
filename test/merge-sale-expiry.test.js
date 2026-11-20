const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parse } = require("csv-parse/sync");
const { ALL_DEALS_ID } = require("../dedupe-campaign-rows");

function mergeFixtures(t, fixtures) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-sale-expiry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const [region, rows] of Object.entries(fixtures)) {
    fs.writeFileSync(
      path.join(dir, `en-${region}_campaign_deals.json`),
      JSON.stringify(rows)
    );
  }

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "merge-en-csvs.js")],
    { cwd: dir, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);

  for (const [region, rows] of Object.entries(fixtures)) {
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, `en-${region}_campaign_deals.json`), "utf8")),
      rows
    );
  }

  return {
    json: JSON.parse(fs.readFileSync(path.join(dir, "csvjsontr.json"), "utf8")),
    csv: parse(fs.readFileSync(path.join(dir, "csvjsontr.csv"), "utf8"), {
      columns: true,
      bom: true,
    }),
  };
}

function offer(slug, category, end, salePrice = "10") {
  return {
    Title: slug,
    Slug: slug,
    CampaignCategoryId: category,
    SaleEnds: end,
    SaleStarted: "2026-11-20",
    Price: "20",
    SalePrice: salePrice,
  };
}

test("named campaign expiries win across regions regardless of input order", (t) => {
  const early = "2026-11-20T23:59:00.000Z";
  const campaignEnd = "2026-11-30T14:59:00.000Z";
  const { json, csv } = mergeFixtures(t, {
    id: [
      offer("all-deals-first", ALL_DEALS_ID, early, "8"),
      offer("named-first", "named-campaign", campaignEnd, "9"),
    ],
    us: [
      offer("all-deals-first", "named-campaign", campaignEnd, "11"),
      offer("named-first", ALL_DEALS_ID, early, "12"),
    ],
  });

  for (const rows of [json, csv]) {
    assert.deepEqual(rows.map(row => row.SaleEnds), [campaignEnd, campaignEnd]);
    assert.deepEqual(
      rows.map(row => [row.idSalePrice, row.usSalePrice, row.SaleStarted]),
      [["8", "11", "2026-11-20"], ["9", "12", "2026-11-20"]]
    );
  }
});

test("earliest named expiry wins while All Deals-only games keep the fallback", (t) => {
  const earliest = "2026-11-20T23:59:00.000Z";
  const namedEnd = "2026-11-30T14:59:00.000Z";
  const later = "2026-12-01T07:59:00.000Z";
  const { json } = mergeFixtures(t, {
    id: [
      offer("multiple-campaigns", "named-campaign", later),
      offer("all-deals-only", ALL_DEALS_ID, later),
      offer("blank-named-expiry", "named-campaign", ""),
      offer("unknown-campaign", "", earliest),
    ],
    in: [
      offer("multiple-campaigns", ALL_DEALS_ID, earliest),
      offer("all-deals-only", ALL_DEALS_ID, earliest),
      offer("blank-named-expiry", ALL_DEALS_ID, earliest),
    ],
    hk: [
      offer("multiple-campaigns", "other-named-campaign", namedEnd),
      offer("unknown-campaign", "named-campaign", namedEnd),
    ],
  });

  assert.deepEqual(
    Object.fromEntries(json.map(row => [row.Slug, row.SaleEnds])),
    {
      "multiple-campaigns": namedEnd,
      "all-deals-only": earliest,
      "blank-named-expiry": earliest,
      "unknown-campaign": namedEnd,
    }
  );
});
