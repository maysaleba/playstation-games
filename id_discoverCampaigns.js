// discoverCampaigns.js
// Node 18+

const fs = require("fs/promises");

const LOCALE = "en-id";
const SIZE = 100;

const CACHE_FILE = `${LOCALE}_campaign_cache.json`;

const ALL_DEALS_CATEGORY = {
  categoryId: "3f772501-f6f8-49b7-abac-874a88ca4897",
  internalName: "cat.gma.AllDeals",
  emsViewId: "static",
};

const CATEGORY_GRID_HASH =
  "4e41660b6732f35c99fc5541926b7502a09557924e8c2cfebd1beb1a5c8c8f81";

const PRODUCT_DETAIL_HASH =
  "fb0bfa0af4d8dc42b28fa5c077ed715543e7fb8a3deff8117a50b99864d246f1";

const STORE_DISPLAY_CLASSIFICATION_FILTERS = [
  "storeDisplayClassification:FULL_GAME",
  "storeDisplayClassification:GAME_BUNDLE",
  "storeDisplayClassification:PREMIUM_EDITION",
];

function decodeHtmlAttr(value) {
  return value.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function getDiscountPercent(product) {
  const discountText = String(product.price?.discountText || "").trim();

  const match = discountText.match(/(\d{1,3})%/);
  if (!match) return null;

  const percent = Number(match[1]);

  if (percent <= 0 || percent >= 100) return null;

  return percent;
}

function isValidDiscount(product) {
  return getDiscountPercent(product) !== null;
}

async function fetchDealCampaignBanners(locale) {
  const url = `https://store.playstation.com/${locale}/pages/deals`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": locale,
    },
  });

  if (!res.ok) throw new Error(`Deals page HTTP ${res.status}`);

  const html = await res.text();
  const telemetryRegex = /data-telemetry-meta="([^"]+)"/g;
  const banners = [];
  let match;

  while ((match = telemetryRegex.exec(html)) !== null) {
    let meta;

    try {
      meta = JSON.parse(decodeHtmlAttr(match[1]));
    } catch {
      continue;
    }

    if (meta.contentSource !== "emsBanner") continue;

    const categoryMatch = meta.interactLink?.match(
      /EMS_CATEGORY:([^:"]+):?([^"]*)?/
    );

    if (!categoryMatch) continue;

    banners.push({
      categoryId: categoryMatch[1],
      internalName: categoryMatch[2] || "",
      emsViewId: meta.emsViewId || "",
    });
  }

  const unique = new Map();

  for (const b of banners) {
    unique.set(`${b.emsViewId}:${b.categoryId}`, b);
  }

  const allBanners = [...unique.values()];
  const saleBannerViewId = allBanners[0]?.emsViewId;

  return allBanners.filter((b) => b.emsViewId === saleBannerViewId);
}

async function graphqlGet(operationName, variables, hash) {
  const url = new URL("https://web.np.playstation.com/api/graphql/v1/op");

  url.searchParams.set("operationName", operationName);
  url.searchParams.set("variables", JSON.stringify(variables));
  url.searchParams.set(
    "extensions",
    JSON.stringify({
      persistedQuery: {
        version: 1,
        sha256Hash: hash,
      },
    })
  );

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json",
      "Content-Type": "application/json",
      "Accept-Language": LOCALE,
      "x-apollo-operation-name": operationName,
      "apollo-require-preflight": "true",
      "x-psn-store-locale-override": LOCALE,
    },
  });

  const text = await res.text();

  if (!res.ok) {
    console.error("Operation:", operationName);
    console.error("Variables:", JSON.stringify(variables, null, 2));
    console.error("Response:", text);
    throw new Error(`${operationName} HTTP ${res.status}`);
  }

  return JSON.parse(text);
}

async function fetchCategoryPage(categoryId, offset, size, filterBy) {
  const json = await graphqlGet(
    "categoryGridRetrieve",
    {
      id: categoryId,
      pageArgs: { size, offset },
      sortBy: {
        name: "productReleaseDate",
        isAscending: false,
      },
      filterBy,
      facetOptions: [],
    },
    CATEGORY_GRID_HASH
  );

  return json.data?.categoryGridRetrieve?.products || [];
}

async function fetchSampleProductId(categoryId) {
  const filterBy = [...STORE_DISPLAY_CLASSIFICATION_FILTERS];

  for (let offset = 0; ; offset += SIZE) {
    const products = await fetchCategoryPage(categoryId, offset, SIZE, filterBy);
    const valid = products.filter(isValidDiscount);

    if (valid.length > 0) {
      return {
        id: valid[0].id,
        name: valid[0].name || "",
      };
    }

    if (products.length < SIZE) break;
  }

  return null;
}

async function fetchProductSaleEnd(productId) {
  const json = await graphqlGet(
    "productRetrieveForUpsellWithCtas",
    { productId },
    PRODUCT_DETAIL_HASH
  );

  const products = json?.data?.productRetrieve?.concept?.products || [];

  for (const product of products) {
    for (const cta of product.webctas || []) {
      const endTime = cta?.price?.endTime;

      if (endTime) {
        return new Date(Number(endTime)).toISOString().slice(0, 10);
      }
    }
  }

  return "";
}

async function discoverCampaigns() {
  const today = todayIso();

  const cache = await readJsonFile(CACHE_FILE, {
    active: {},
    history: {},
  });

  const campaignsToRun = [];
  const campaignsToRemove = [];

  console.log(`Discovering campaigns for ${LOCALE}...`);

  const currentCampaigns = await fetchDealCampaignBanners(LOCALE);
  const currentCampaignIds = new Set(currentCampaigns.map((c) => c.categoryId));

  console.log(`Found ${currentCampaigns.length} current campaign banners.`);

  // Deals page is source of truth.
  // If campaign is gone from page, remove it.
  for (const [categoryId, cached] of Object.entries(cache.active)) {
    const missingFromCurrentDealsPage = !currentCampaignIds.has(categoryId);

    if (missingFromCurrentDealsPage) {
      const removedCampaign = {
        ...cached,
        categoryId,
        endedReason: "missing from deals page",
        endedDetectedAt: today,
      };

      campaignsToRemove.push(removedCampaign);

      cache.history[categoryId] = {
        ...removedCampaign,
        ended: true,
      };

      delete cache.active[categoryId];
    }
  }

  // New or never-ran campaigns only.
  for (const campaign of currentCampaigns) {
    const cached = cache.active[campaign.categoryId];

    if (cached?.lastRan) {
      console.log(`Skipping already-ran active campaign: ${campaign.internalName}`);
      continue;
    }

    console.log(`Checking new campaign: ${campaign.internalName}`);

    const sample = await fetchSampleProductId(campaign.categoryId);

    if (!sample) {
      console.warn(`No sample product found for ${campaign.internalName}`);
      continue;
    }

    const saleEnds = await fetchProductSaleEnd(sample.id);

    const campaignWithMeta = {
      ...campaign,
      saleEnds,
      sampleProductId: sample.id,
      sampleProductName: sample.name,
      discoveredAt: today,
    };

    cache.active[campaign.categoryId] = {
      ...campaignWithMeta,
      lastRan: "",
      region: LOCALE,
    };

    campaignsToRun.push(campaignWithMeta);
  }

  // Run AllDeals only when a new campaign exists.
  if (campaignsToRun.length > 0) {
    const earliestSaleEnds =
      campaignsToRun
        .map((c) => c.saleEnds)
        .filter(Boolean)
        .sort()[0] || "";

    campaignsToRun.push({
      ...ALL_DEALS_CATEGORY,
      saleEnds: earliestSaleEnds,
      discoveredAt: today,
      reason: "Included because at least one new campaign needs processing",
    });
  }

  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");

  return {
    cache,
    campaignsToRun,
    campaignsToRemove,
  };
}

module.exports = {
  discoverCampaigns,
  CACHE_FILE,
  LOCALE,
};

if (require.main === module) {
  discoverCampaigns()
    .then(({ campaignsToRun, campaignsToRemove }) => {
      console.log("\nDiscovery complete.");
      console.log(`Campaigns to run: ${campaignsToRun.length}`);
      console.log(`Campaigns to remove: ${campaignsToRemove.length}`);
      console.log(`Cache: ${CACHE_FILE}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}