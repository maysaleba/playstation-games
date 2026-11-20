const test = require("node:test");
const assert = require("node:assert/strict");
const { dedupeRows } = require("../dedupe-campaign-rows");

const allDeals = {
  id: "game-1",
  CampaignCategoryId: "3f772501-f6f8-49b7-abac-874a88ca4897",
  CampaignName: "cat.gma.AllDeals",
  SaleEnds: "2026-11-20T14:59:00.000Z",
  SaleStarted: "2026-11-04",
  SalePrice: "10",
};

const namedCampaign = {
  ...allDeals,
  CampaignCategoryId: "named-campaign",
  CampaignName: "Black Friday",
  SaleEnds: "2026-11-30T14:59:00.000Z",
  SalePrice: "12",
};

test("named campaigns beat All Deals regardless of expiry or row order", () => {
  for (const end of [
    "2026-11-10T14:59:00.000Z",
    allDeals.SaleEnds,
    namedCampaign.SaleEnds,
    "",
  ]) {
    const named = { ...namedCampaign, SaleEnds: end };
    assert.deepEqual(dedupeRows([allDeals, named]), [named]);
    assert.deepEqual(dedupeRows([named, allDeals]), [named]);
  }
});

test("promoting an All Deals row preserves its existing sale start", () => {
  const named = { ...namedCampaign, SaleStarted: "2026-11-19" };
  assert.deepEqual(dedupeRows([allDeals, named]), [
    { ...named, SaleStarted: allDeals.SaleStarted },
  ]);
  assert.deepEqual(
    dedupeRows([{ ...allDeals, SaleStarted: "" }, named]),
    [named]
  );
});

test("same-priority rows retain earlier-expiry and first-row tie behavior", () => {
  for (const original of [allDeals, namedCampaign]) {
    const earlier = { ...original, SaleEnds: "2026-11-10T14:59:00.000Z" };
    assert.deepEqual(dedupeRows([original, earlier]), [earlier]);
    assert.deepEqual(dedupeRows([earlier, original]), [earlier]);
    assert.deepEqual(
      dedupeRows([{ ...original, SaleEnds: "" }, original]),
      [original]
    );
    assert.deepEqual(
      dedupeRows([original, { ...original, SalePrice: "99" }]),
      [original]
    );
  }
});

test("All Deals-only games and different product IDs are retained", () => {
  const otherGame = { ...namedCampaign, id: "game-2" };
  assert.deepEqual(dedupeRows([allDeals, otherGame]), [allDeals, otherGame]);
});
