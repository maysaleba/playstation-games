// discoverCampaigns.js
// Node 18+

const fs = require("fs/promises");

const LOCALE = "en-sg";
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

function decodeHtmlAttr(value = "") {
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

function isUuid(value) {
  return /^[a-f0-9-]{36}$/i.test(String(value || ""));
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

async function fetchHtml(url, locale) {
  console.log(`Fetching URL: ${url}`);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": locale,
    },
  });

  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);

  return await res.text();
}

function extractNextDataJson(html) {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );

  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function findCampaignCategoriesFromNextData(html) {
  const json = extractNextDataJson(html);
  const found = [];

  function walk(value, context = {}) {
    if (!value || typeof value !== "object") return;

    const nextContext = {
      ...context,
      name: value.name || context.name || "",
      reportingName: value.reportingName || context.reportingName || "",
      title: value.title || context.title || "",
    };

    if (
      value.__typename === "EMSLink" &&
      value.type === "EMS_CATEGORY" &&
      isUuid(value.target)
    ) {
      found.push({
        categoryId: value.target,
        internalName:
          value.localizedName ||
          nextContext.name ||
          nextContext.reportingName ||
          "",
        emsViewId: "",
        source: "nextData.EMSLink",
        strandName:
          nextContext.name ||
          nextContext.reportingName ||
          nextContext.title ||
          "",
      });
    }

    if (isUuid(value.priceSourceId)) {
      found.push({
        categoryId: value.priceSourceId,
        internalName:
          nextContext.name ||
          nextContext.reportingName ||
          nextContext.title ||
          "",
        emsViewId: "",
        source: "nextData.priceSourceId",
        strandName:
          nextContext.name ||
          nextContext.reportingName ||
          nextContext.title ||
          "",
      });
    }

    for (const child of Object.values(value)) {
      walk(child, nextContext);
    }
  }

  walk(json);

  return found;
}

function extractCampaignBannersFromHtml(html, mode = "deals") {
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

    const categoryMatch = meta.interactLink?.match(
      /EMS_CATEGORY:([^:"]+):?([^"]*)?/
    );

    if (categoryMatch) {
      banners.push({
        categoryId: categoryMatch[1],
        internalName:
          categoryMatch[2] ||
          meta.strandName ||
          meta.interactAction ||
          "",
        emsViewId: meta.emsViewId || "",
        source: meta.contentSource || "",
        strandName: meta.strandName || "",
      });
      continue;
    }

    if (mode === "view" && isUuid(meta.emsCategoryId)) {
      banners.push({
        categoryId: meta.emsCategoryId,
        internalName: meta.strandName || meta.interactAction || "",
        emsViewId: meta.emsViewId || "",
        source: meta.contentSource || "",
        strandName: meta.strandName || "",
      });
      continue;
    }

    const viewMatch = meta.interactLink?.match(/EMS_VIEW:([^:"]+)/);

    if (viewMatch) {
      banners.push({
        type: "EMS_VIEW",
        viewId: viewMatch[1],
        experienceId: meta.emsExperienceId || "",
        internalName: meta.interactAction || "EMS_VIEW",
        emsViewId: meta.emsViewId || "",
        source: meta.contentSource || "",
      });
    }
  }

  if (mode === "view") {
    const hrefCategoryRegex = /href="\/[^"]+\/category\/([a-f0-9-]{36})\/1"/g;

    while ((match = hrefCategoryRegex.exec(html)) !== null) {
      banners.push({
        categoryId: match[1],
        internalName: "",
        emsViewId: "",
        source: "href",
        strandName: "",
      });
    }
  }

  return banners;
}

function dedupeCampaigns(banners) {
  const map = new Map();

  for (const b of banners) {
    if (!b.categoryId) continue;

    const existing = map.get(b.categoryId);

    if (!existing) {
      map.set(b.categoryId, b);
      continue;
    }

    const sourceRank = {
      "nextData.priceSourceId": 5,
      "nextData.EMSLink": 4,
      emsStrand: 3,
      emsBanner: 2,
      href: 1,
    };

    const existingRank = sourceRank[existing.source] || 0;
    const newRank = sourceRank[b.source] || 0;

    if (newRank > existingRank) {
      map.set(b.categoryId, b);
    }
  }

  return [...map.values()];
}

function pickCampaignCategoriesFromView(banners) {
  const deduped = dedupeCampaigns(banners);

  // Best generic signal: primary EMS_CATEGORY link from Next data
  const nextDataLinks = deduped.filter((b) => b.source === "nextData.EMSLink");

  if (nextDataLinks.length > 0) {
    return nextDataLinks.slice(0, 1);
  }

  // Fallback: first strand category from the view page
  const emsStrands = deduped.filter((b) => b.source === "emsStrand");

  if (emsStrands.length > 0) {
    return emsStrands.slice(0, 1);
  }

  return deduped.slice(0, 1);
}

async function fetchViewCampaignBanners(locale, banner) {
  const url = banner.experienceId
    ? `https://store.playstation.com/${locale}/view/${banner.experienceId}/${banner.viewId}`
    : `https://store.playstation.com/${locale}/view/${banner.viewId}`;

  const html = await fetchHtml(url, locale);

  const fromNextData = findCampaignCategoriesFromNextData(html);
  const fromTelemetry = extractCampaignBannersFromHtml(html, "view");

  return [...fromNextData, ...fromTelemetry];
}

async function expandBanner(locale, banner, depth = 0, seenViews = new Set()) {
  if (banner.type !== "EMS_VIEW" || !banner.viewId) {
    return [banner];
  }

  if (depth >= 3) {
    console.warn(`Max EMS_VIEW depth reached: ${banner.viewId}`);
    return [];
  }

  if (seenViews.has(banner.viewId)) {
    console.warn(`Skipping duplicate EMS_VIEW: ${banner.viewId}`);
    return [];
  }

  seenViews.add(banner.viewId);

  console.log(`Expanding EMS_VIEW: ${banner.viewId}`);

  const viewBannersRaw = await fetchViewCampaignBanners(locale, banner);

  console.log(`Found ${viewBannersRaw.length} raw categories inside EMS_VIEW`);

  for (const b of viewBannersRaw) {
    console.log(
      `  VIEW RAW: ${b.categoryId || b.viewId} | ${b.internalName || b.strandName || b.source || ""}`
    );
  }

  const viewBanners = pickCampaignCategoriesFromView(viewBannersRaw);
  const expanded = [];

  for (const viewBanner of viewBanners) {
    const children = await expandBanner(
      locale,
      viewBanner,
      depth + 1,
      seenViews
    );

    for (const child of children) {
      expanded.push({
        ...child,
        parentViewId: banner.viewId,
      });
    }
  }

  return expanded;
}

async function fetchDealCampaignBanners(locale) {
  const url = `https://store.playstation.com/${locale}/pages/deals`;
  const html = await fetchHtml(url, locale);

  const rawBanners = extractCampaignBannersFromHtml(html, "deals");

  // Keep only the first/top banner collection from the deals page.
  // This prevents All Deals / See More / PS5 Games / Add-ons etc.
  const topViewId = rawBanners[0]?.emsViewId;
  const topBanners = topViewId
    ? rawBanners.filter((b) => b.emsViewId === topViewId)
    : rawBanners;

  const expandedBanners = [];

  for (const banner of topBanners) {
    const expanded = await expandBanner(locale, banner);
    expandedBanners.push(...expanded);
  }

  return dedupeCampaigns(expandedBanners);
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

  for (const campaign of currentCampaigns) {
    console.log(
      `Detected campaign: ${campaign.categoryId} | ${campaign.internalName || campaign.strandName || campaign.source || ""}`
    );
  }

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

  for (const campaign of currentCampaigns) {
    const cached = cache.active[campaign.categoryId];

    if (cached?.lastRan) {
      console.log(`Skipping already-ran active campaign: ${campaign.internalName}`);
      continue;
    }

    console.log(
      `Checking new campaign: ${campaign.internalName || campaign.categoryId}`
    );

    const sample = await fetchSampleProductId(campaign.categoryId);

    if (!sample) {
      console.warn(
        `No sample product found for ${campaign.internalName || campaign.categoryId}`
      );
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

  const shouldRunAllDeals =
    campaignsToRun.length > 0 || campaignsToRemove.length > 0;

  if (shouldRunAllDeals) {
    const earliestSaleEnds =
      campaignsToRun
        .map((c) => c.saleEnds)
        .filter(Boolean)
        .sort()[0] || "";

    campaignsToRun.push({
      ...ALL_DEALS_CATEGORY,
      saleEnds: earliestSaleEnds,
      discoveredAt: today,
      reason:
        campaignsToRun.length > 0
          ? "Included because at least one new campaign needs processing"
          : "Included because at least one campaign expired/was removed",
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