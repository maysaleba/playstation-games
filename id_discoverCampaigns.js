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

const GET_EXPERIENCE_HASH =
  "b5078800ed1bdebee9800979f9306abeadc5169030263f7095fe573b12e52270";

const GET_VIEW_HASH =
  "beaeeae873a79849b2bf1df0dde1c14cf72d99cd439d9b2c2387f0edc649596c";

const STORE_CLIENT_ID =
  "b6de8d4d-bf9b-11ee-ad2a-aea73dc1ea43";

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

  if (!res.ok) {
    throw new Error(`${url} HTTP ${res.status}`);
  }

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
    const hrefCategoryRegex =
      /href="\/[^"]+\/category\/([a-f0-9-]{36})\/1"/g;

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

  for (const banner of banners) {
    if (!banner.categoryId) continue;

    const existing = map.get(banner.categoryId);

    if (!existing) {
      map.set(banner.categoryId, banner);
      continue;
    }

    const sourceRank = {
      "nextData.priceSourceId": 5,
      "nextData.EMSLink": 4,
      emsStrandCategoryId: 4,
      emsStrand: 3,
      emsBanner: 2,
      href: 1,
    };

    const existingRank = sourceRank[existing.source] || 0;
    const newRank = sourceRank[banner.source] || 0;

    if (newRank > existingRank) {
      map.set(banner.categoryId, banner);
    }
  }

  return [...map.values()];
}

function pickCampaignCategoriesFromView(banners) {
  const deduped = dedupeCampaigns(banners);

  // Best generic signal: primary EMS_CATEGORY link from Next data.
  const nextDataLinks = deduped.filter(
    (banner) => banner.source === "nextData.EMSLink"
  );

  if (nextDataLinks.length > 0) {
    return nextDataLinks.slice(0, 1);
  }

  // Fallback: first strand category from the view page.
  const emsStrands = deduped.filter(
    (banner) => banner.source === "emsStrand"
  );

  if (emsStrands.length > 0) {
    return emsStrands.slice(0, 1);
  }

  return deduped.slice(0, 1);
}

function extractCampaignBannersFromViewUnion(
  viewUnion,
  experienceId = ""
) {
  const banners = [];

  function addCategoryBanner(component, context, source) {
    const categoryId =
      component?.link?.target ||
      component?.viewAllLink?.target ||
      component?.categoryId ||
      component?.priceSourceId;

    if (!isUuid(categoryId)) {
      return;
    }

    banners.push({
      categoryId,
      internalName:
        component?.link?.localizedName ||
        component?.title ||
        component?.name ||
        component?.telemetryData?.interactAction ||
        context.reportingName ||
        "",
      emsViewId: context.emsViewId || "",
      source,
      strandName:
        component?.telemetryData?.strandName ||
        context.reportingName ||
        "",
    });
  }

  function addViewBanner(component, context) {
    const viewId = component?.link?.target;

    if (!isUuid(viewId)) {
      return;
    }

    banners.push({
      type: "EMS_VIEW",
      viewId,
      experienceId,
      internalName:
        component?.telemetryData?.interactAction ||
        context.reportingName ||
        "EMS_VIEW",
      emsViewId: context.emsViewId || "",
      source: component?.telemetryData?.contentSource || "emsBanner",
      strandName: context.reportingName || "",
    });
  }

  function walk(value, context = {}) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (value.__typename === "EMSViewCollection") {
      for (const childView of value.childViews || []) {
        walk(childView, context);
      }

      return;
    }

    if (value.__typename !== "EMSView") {
      return;
    }

    const viewContext = {
      ...context,
      emsViewId: value?.telemetryData?.emsViewId || value.id || "",
      reportingName: value.reportingName || context.reportingName || "",
      purpose: value.purpose || context.purpose || "",
    };

    for (const component of value.components || []) {
      const linkType =
        component?.link?.type || component?.viewAllLink?.type || "";

      if (linkType === "EMS_CATEGORY") {
        const source =
          component?.telemetryData?.contentSource ||
          (component.__typename === "EMSStrandComponent"
            ? "emsStrand"
            : "emsBanner");

        addCategoryBanner(component, viewContext, source);
      }

      if (
        component.__typename === "EMSStrandComponent" &&
        isUuid(component.categoryId)
      ) {
        addCategoryBanner(
          component,
          viewContext,
          "emsStrandCategoryId"
        );
      }

      if (component?.link?.type === "EMS_VIEW") {
        addViewBanner(component, viewContext);
      }
    }
  }

  walk(viewUnion);

  return banners;
}

function extractCampaignBannersFromExperience(experience) {
  const banners = [];

  for (const view of experience?.views || []) {
    banners.push(
      ...extractCampaignBannersFromViewUnion(
        view,
        experience?.id || ""
      )
    );
  }

  return banners;
}

async function fetchViewCampaignBannersFromApi(banner) {
  if (!banner?.viewId || !banner?.experienceId) {
    return [];
  }

  const json = await graphqlGet(
    "getView",
    {
      experienceId: banner.experienceId,
      viewId: banner.viewId,
    },
    GET_VIEW_HASH
  );

  const viewUnion = json?.data?.emsViewRetrieve;

  if (!viewUnion) {
    return [];
  }

  return extractCampaignBannersFromViewUnion(
    viewUnion,
    banner.experienceId
  );
}

async function fetchDealCampaignBannersFromExperience(locale) {
  const json = await graphqlGet(
    "getExperience",
    {
      clientId: STORE_CLIENT_ID,
      alias: "deals",
    },
    GET_EXPERIENCE_HASH
  );

  const experience = json?.data?.emsExperienceRetrieve;

  if (!experience) {
    return [];
  }

  const rawBanners = extractCampaignBannersFromExperience(experience);

  const topViewId = rawBanners[0]?.emsViewId;

  const topBanners = topViewId
    ? rawBanners.filter((banner) => banner.emsViewId === topViewId)
    : rawBanners;

  const expandedTopBanners = [];

  for (const banner of topBanners) {
    const expanded = await expandBanner(locale, banner);
    expandedTopBanners.push(...expanded);
  }

  const dedupedTop = dedupeCampaigns(expandedTopBanners);

  if (dedupedTop.length > 0) {
    return dedupedTop;
  }

  console.warn(
    "Top deals view did not resolve to EMS_CATEGORY. Falling back to all direct EMS_CATEGORY banners."
  );

  return dedupeCampaigns(
    rawBanners.filter((banner) => banner.categoryId)
  );
}

async function fetchViewCampaignBanners(locale, banner) {
  try {
    const fromApi = await fetchViewCampaignBannersFromApi(
      banner
    );

    if (fromApi.length > 0) {
      return fromApi;
    }
  } catch (error) {
    console.warn(
      `getView API fallback failed for ${banner.viewId}: ${error.message}`
    );
  }

  const url = banner.experienceId
    ? `https://store.playstation.com/${locale}/view/${banner.experienceId}/${banner.viewId}`
    : `https://store.playstation.com/${locale}/view/${banner.viewId}`;

  const html = await fetchHtml(url, locale);

  const fromNextData = findCampaignCategoriesFromNextData(html);
  const fromTelemetry = extractCampaignBannersFromHtml(html, "view");

  return [...fromNextData, ...fromTelemetry];
}

async function expandBanner(
  locale,
  banner,
  depth = 0,
  seenViews = new Set()
) {
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

  console.log(
    `Found ${viewBannersRaw.length} raw categories inside EMS_VIEW`
  );

  for (const viewBanner of viewBannersRaw) {
    console.log(
      `  VIEW RAW: ${
        viewBanner.categoryId || viewBanner.viewId
      } | ${
        viewBanner.internalName ||
        viewBanner.strandName ||
        viewBanner.source ||
        ""
      }`
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

  if (rawBanners.length === 0) {
    console.warn(
      "No campaign telemetry found in Deals HTML. Trying GraphQL experience fallback."
    );

    return await fetchDealCampaignBannersFromExperience(locale);
  }

  // Keep only the first/top banner collection from the Deals page.
  // This prevents All Deals / See More / PS5 Games / Add-ons, etc.
  const topViewId = rawBanners[0]?.emsViewId;

  const topBanners = topViewId
    ? rawBanners.filter((banner) => banner.emsViewId === topViewId)
    : rawBanners;

  const expandedBanners = [];

  for (const banner of topBanners) {
    const expanded = await expandBanner(locale, banner);
    expandedBanners.push(...expanded);
  }

  const deduped = dedupeCampaigns(expandedBanners);

  if (deduped.length > 0) {
    return deduped;
  }

  console.warn(
    "HTML campaign extraction produced no categories. Trying GraphQL experience fallback."
  );

  return await fetchDealCampaignBannersFromExperience(locale);
}

function isPersistedQueryHashFailure(responseText = "") {
  const text = String(responseText).toLowerCase();

  return (
    text.includes("not whitelisted") ||
    text.includes("persistedquerynotfound") ||
    text.includes("persisted query not found") ||
    text.includes("persisted_query_not_found")
  );
}

async function graphqlGet(operationName, variables, hash) {
  const url = new URL(
    "https://web.np.playstation.com/api/graphql/v1/op"
  );

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
    if (isPersistedQueryHashFailure(text)) {
      console.error(
        `HASH_CHECK_FAILED: ${operationName} persisted query may be outdated. Refresh GET_EXPERIENCE_HASH / GET_VIEW_HASH / STORE_CLIENT_ID.`
      );
    }

    console.error("Operation:", operationName);
    console.error("Variables:", JSON.stringify(variables, null, 2));
    console.error("Response:", text);

    throw new Error(`${operationName} HTTP ${res.status}`);
  }

  const json = JSON.parse(text);

  if (
    Array.isArray(json?.errors) &&
    isPersistedQueryHashFailure(JSON.stringify(json.errors))
  ) {
    console.error(
      `HASH_CHECK_FAILED: ${operationName} returned persisted-query errors. Refresh GET_EXPERIENCE_HASH / GET_VIEW_HASH / STORE_CLIENT_ID.`
    );
  }

  return json;
}

async function fetchCategoryPage(
  categoryId,
  offset,
  size,
  filterBy,
  returnRaw = false
) {
  const json = await graphqlGet(
    "categoryGridRetrieve",
    {
      id: categoryId,
      pageArgs: {
        size,
        offset,
      },
      sortBy: {
        name: "productReleaseDate",
        isAscending: false,
      },
      filterBy,
      facetOptions: [],
    },
    CATEGORY_GRID_HASH
  );

  if (returnRaw) {
    return json;
  }

  return json.data?.categoryGridRetrieve?.products || [];
}

async function fetchTypeFacetCounts(categoryId) {
  const json = await fetchCategoryPage(
    categoryId,
    0,
    24,
    [...STORE_DISPLAY_CLASSIFICATION_FILTERS],
    true
  );

  return getTrackedTypeFacetCounts(json);
}

function getTrackedTypeFacetCounts(productsResponse) {
  const trackedKeys = [
    "FULL_GAME",
    "GAME_BUNDLE",
    "PREMIUM_EDITION",
  ];

  const typeFacet =
    productsResponse?.data?.categoryGridRetrieve?.facetOptions?.find(
      (facet) => facet.name === "storeDisplayClassification"
    );

  const counts = {};

  for (const key of trackedKeys) {
    const value = typeFacet?.values?.find(
      (facetValue) => facetValue.key === key
    );

    counts[key] = value?.count ?? 0;
  }

  return counts;
}

function facetCountsChanged(oldCounts = {}, newCounts = {}) {
  return [
    "FULL_GAME",
    "GAME_BUNDLE",
    "PREMIUM_EDITION",
  ].some(
    (key) =>
      Number(oldCounts[key] || 0) !==
      Number(newCounts[key] || 0)
  );
}

function isExpiredSaleEnd(value) {
  if (!value) return false;

  const time = Date.parse(value);

  if (Number.isNaN(time)) {
    return false;
  }

  return time <= Date.now();
}

async function fetchSampleProductId(categoryId) {
  const filterBy = [
    ...STORE_DISPLAY_CLASSIFICATION_FILTERS,
  ];

  for (let offset = 0; ; offset += SIZE) {
    const products = await fetchCategoryPage(
      categoryId,
      offset,
      SIZE,
      filterBy
    );

    const validProducts = products.filter(isValidDiscount);

    if (validProducts.length > 0) {
      return {
        id: validProducts[0].id,
        name: validProducts[0].name || "",
      };
    }

    if (products.length < SIZE) {
      break;
    }
  }

  return null;
}

async function fetchProductSaleEnd(productId) {
  const json = await graphqlGet(
    "productRetrieveForUpsellWithCtas",
    {
      productId,
    },
    PRODUCT_DETAIL_HASH
  );

  const products =
    json?.data?.productRetrieve?.concept?.products || [];

  for (const product of products) {
    for (const cta of product.webctas || []) {
      const endTime = cta?.price?.endTime;

      if (endTime) {
        return new Date(Number(endTime)).toISOString();
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

  const currentCampaigns =
    await fetchDealCampaignBanners(LOCALE);

  const currentCampaignIds = new Set(
    currentCampaigns.map(
      (campaign) => campaign.categoryId
    )
  );

  console.log(
    `Found ${currentCampaigns.length} current campaign banners.`
  );

  for (const campaign of currentCampaigns) {
    console.log(
      `Detected campaign: ${
        campaign.categoryId
      } | ${
        campaign.internalName ||
        campaign.strandName ||
        campaign.source ||
        ""
      }`
    );
  }

  /*
   * Remove cached campaigns that no longer appear on the
   * PlayStation Deals page.
   */
  for (
    const [categoryId, cached] of
    Object.entries(cache.active)
  ) {
    if (
      categoryId === ALL_DEALS_CATEGORY.categoryId
    ) {
      continue;
    }

    const missingFromCurrentDealsPage =
      !currentCampaignIds.has(categoryId);

    if (!missingFromCurrentDealsPage) {
      continue;
    }

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

  for (const campaign of currentCampaigns) {
    const cached =
      cache.active[campaign.categoryId];

    /*
     * Existing campaign that has already been scraped.
     */
    if (cached?.lastRan) {
      /*
       * The campaign is still visible, but the stored sale
       * end has passed.
       *
       * Sample another currently discounted product and ask
       * its product page for a fresh end date. This handles
       * campaigns that Sony extends without changing the
       * campaign/category ID.
       */
      if (isExpiredSaleEnd(cached.saleEnds)) {
        console.log(
          `Cached SaleEnds has expired for visible campaign: ${
            campaign.internalName ||
            campaign.categoryId
          }. Re-sampling a product.`
        );

        const refreshedSample =
          await fetchSampleProductId(
            campaign.categoryId
          );

        const refreshedSaleEnds =
          refreshedSample
            ? await fetchProductSaleEnd(
                refreshedSample.id
              )
            : "";

        if (
          refreshedSaleEnds &&
          refreshedSaleEnds !== cached.saleEnds
        ) {
          console.log(
            `Refreshed SaleEnds: ${
              cached.saleEnds
            } -> ${refreshedSaleEnds}`
          );

          const currentFacetCounts =
            await fetchTypeFacetCounts(
              campaign.categoryId
            );

          campaignsToRun.push({
            ...campaign,
            saleEnds: refreshedSaleEnds,
            sampleProductId:
              refreshedSample.id,
            sampleProductName:
              refreshedSample.name,
            discoveredAt:
              cached.discoveredAt || today,
            typeFacetCounts:
              currentFacetCounts,
            reason:
              "Expired sale end refreshed",
          });

          cache.active[campaign.categoryId] = {
            ...cached,
            ...campaign,
            saleEnds: refreshedSaleEnds,
            sampleProductId:
              refreshedSample.id,
            sampleProductName:
              refreshedSample.name,
            typeFacetCounts:
              currentFacetCounts,
            lastRan: "",
            region: LOCALE,
          };

          /*
           * No need to perform another facet-count check.
           * The campaign is already scheduled for a full rerun.
           */
          continue;
        }

        if (!refreshedSample) {
          console.warn(
            `No discounted sample product found while refreshing ${
              campaign.internalName ||
              campaign.categoryId
            }.`
          );
        } else if (!refreshedSaleEnds) {
          console.warn(
            `The re-sampled product did not provide a SaleEnds value for ${
              campaign.internalName ||
              campaign.categoryId
            }.`
          );
        } else {
          console.warn(
            `Re-sampled product returned the same expired SaleEnds for ${
              campaign.internalName ||
              campaign.categoryId
            }: ${refreshedSaleEnds}`
          );
        }
      }

      console.log(
        `Checking facet counts for active campaign: ${
          campaign.internalName ||
          campaign.categoryId
        }`
      );

      const currentFacetCounts =
        await fetchTypeFacetCounts(
          campaign.categoryId
        );

      const oldFacetCounts =
        cached.typeFacetCounts || {};

      if (
        !facetCountsChanged(
          oldFacetCounts,
          currentFacetCounts
        )
      ) {
        console.log(
          `Skipping unchanged active campaign: ${
            campaign.internalName ||
            campaign.categoryId
          }`
        );

        continue;
      }

      console.log(
        `Facet count changed. Re-running campaign: ${
          campaign.internalName ||
          campaign.categoryId
        }`
      );

      campaignsToRun.push({
        ...campaign,
        saleEnds: cached.saleEnds || "",
        sampleProductId:
          cached.sampleProductId || "",
        sampleProductName:
          cached.sampleProductName || "",
        discoveredAt:
          cached.discoveredAt || today,
        typeFacetCounts:
          currentFacetCounts,
        reason: "Type facet count changed",
      });

      cache.active[campaign.categoryId] = {
        ...cached,
        ...campaign,
        typeFacetCounts:
          currentFacetCounts,
        lastRan: "",
        region: LOCALE,
      };

      continue;
    }

    /*
     * New campaign, or a campaign already queued because
     * its previous scrape did not complete.
     */
    console.log(
      `Checking new campaign: ${
        campaign.internalName ||
        campaign.categoryId
      }`
    );

    const sample =
      await fetchSampleProductId(
        campaign.categoryId
      );

    if (!sample) {
      console.warn(
        `No sample product found for ${
          campaign.internalName ||
          campaign.categoryId
        }`
      );

      continue;
    }

    const saleEnds =
      await fetchProductSaleEnd(sample.id);

    const typeFacetCounts =
      await fetchTypeFacetCounts(
        campaign.categoryId
      );

    const campaignWithMeta = {
      ...campaign,
      saleEnds,
      sampleProductId: sample.id,
      sampleProductName: sample.name,
      discoveredAt: today,
      typeFacetCounts,
    };

    cache.active[campaign.categoryId] = {
      ...campaignWithMeta,
      lastRan: "",
      region: LOCALE,
    };

    campaignsToRun.push(
      campaignWithMeta
    );
  }

  /*
   * Check All Deals separately.
   */
  const allDealsFacetCounts =
    await fetchTypeFacetCounts(
      ALL_DEALS_CATEGORY.categoryId
    );

  const oldAllDealsFacetCounts =
    cache.active[
      ALL_DEALS_CATEGORY.categoryId
    ]?.typeFacetCounts || {};

  const allDealsCountChanged =
    facetCountsChanged(
      oldAllDealsFacetCounts,
      allDealsFacetCounts
    );

  if (allDealsCountChanged) {
    console.log(
      "All Deals count changed. Rebuilding All Deals."
    );

    const allDealsSample =
      await fetchSampleProductId(
        ALL_DEALS_CATEGORY.categoryId
      );

    const allDealsSaleEnds =
      allDealsSample
        ? await fetchProductSaleEnd(
            allDealsSample.id
          )
        : "";

    campaignsToRun.push({
      ...ALL_DEALS_CATEGORY,
      saleEnds: allDealsSaleEnds,
      sampleProductId:
        allDealsSample?.id || "",
      sampleProductName:
        allDealsSample?.name || "",
      discoveredAt: today,
      typeFacetCounts:
        allDealsFacetCounts,
      reason:
        "All Deals count changed",
    });

    cache.active[
      ALL_DEALS_CATEGORY.categoryId
    ] = {
      ...ALL_DEALS_CATEGORY,
      saleEnds: allDealsSaleEnds,
      sampleProductId:
        allDealsSample?.id || "",
      sampleProductName:
        allDealsSample?.name || "",
      typeFacetCounts:
        allDealsFacetCounts,
      lastRan: "",
      region: LOCALE,
    };
  }

  /*
   * Whenever any campaign is added, changed, refreshed, or
   * removed, also rebuild All Deals.
   */
  const shouldRunAllDeals =
    campaignsToRun.length > 0 ||
    campaignsToRemove.length > 0;

  const allDealsAlreadyQueued =
    campaignsToRun.some(
      (campaign) =>
        campaign.categoryId ===
        ALL_DEALS_CATEGORY.categoryId
    );

  if (
    shouldRunAllDeals &&
    !allDealsAlreadyQueued
  ) {
    const earliestSaleEnds =
      campaignsToRun
        .map(
          (campaign) => campaign.saleEnds
        )
        .filter(Boolean)
        .sort()[0] || "";

    campaignsToRun.push({
      ...ALL_DEALS_CATEGORY,
      saleEnds: earliestSaleEnds,
      discoveredAt: today,
      reason:
        campaignsToRun.length > 0
          ? "Included because at least one campaign needs processing"
          : "Included because at least one campaign expired/was removed",
    });
  }

  await fs.writeFile(
    CACHE_FILE,
    JSON.stringify(cache, null, 2),
    "utf8"
  );

  return {
    cache,
    campaignsToRun,
    campaignsToRemove,
  };
}

module.exports = {
  discoverCampaigns,
  fetchSampleProductId,
  fetchProductSaleEnd,
  CACHE_FILE,
  LOCALE,
};

if (require.main === module) {
  discoverCampaigns()
    .then(
      ({
        campaignsToRun,
        campaignsToRemove,
      }) => {
        console.log(
          "\nDiscovery complete."
        );

        console.log(
          `Campaigns to run: ${
            campaignsToRun.length
          }`
        );

        console.log(
          `Campaigns to remove: ${
            campaignsToRemove.length
          }`
        );

        console.log(
          `Cache: ${CACHE_FILE}`
        );
      }
    )
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}