const ALL_DEALS_ID = "3f772501-f6f8-49b7-abac-874a88ca4897";

function dedupeRows(rows) {
  const map = new Map();

  for (const row of rows) {
    const existing = map.get(row.id);

    if (!existing) {
      map.set(row.id, row);
      continue;
    }

    const existingIsAllDeals = existing.CampaignCategoryId === ALL_DEALS_ID;
    const rowIsAllDeals = row.CampaignCategoryId === ALL_DEALS_ID;
    const saleStarted = existing.SaleStarted || row.SaleStarted || "";

    // All Deals has a sampled expiry, so prefer a named campaign over it.
    if (
      (existingIsAllDeals && !rowIsAllDeals) ||
      (
        existingIsAllDeals === rowIsAllDeals &&
        row.SaleEnds &&
        (!existing.SaleEnds || row.SaleEnds < existing.SaleEnds)
      )
    ) {
      map.set(row.id, {
        ...row,
        SaleStarted: saleStarted,
      });
    }
  }

  return [...map.values()];
}

module.exports = { ALL_DEALS_ID, dedupeRows };
