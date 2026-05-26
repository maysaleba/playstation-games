// runCampaignDeals.js
// Node 18+

const fs = require("fs/promises");
const { discoverCampaigns } = require("./tr_discoverCampaigns");

const LOCALE = "en-tr";
const SIZE = 100;

const CACHE_FILE = `${LOCALE}_campaign_cache.json`;
const JSON_FILE = `${LOCALE}_campaign_deals.json`;
const CSV_FILE = `${LOCALE}_campaign_deals.csv`;

const CATEGORY_GRID_HASH =
  "4e41660b6732f35c99fc5541926b7502a09557924e8c2cfebd1beb1a5c8c8f81";


const STORE_DISPLAY_CLASSIFICATION_FILTERS = [
  "storeDisplayClassification:FULL_GAME",
  "storeDisplayClassification:GAME_BUNDLE",
  "storeDisplayClassification:PREMIUM_EDITION",
];

const GENRE_FACETS = [
  { label: "Action", value: "ACTION" },
  { label: "Adventure", value: "ADVENTURE" },
  { label: "Arcade", value: "ARCADE" },
  { label: "Casual", value: "CASUAL" },
  { label: "Role Playing Games", value: "ROLE_PLAYING_GAMES" },
  { label: "Puzzle", value: "PUZZLE" },
  { label: "Simulation", value: "SIMULATION" },
  { label: "Shooter", value: "SHOOTER" },
  { label: "Strategy", value: "STRATEGY" },
  { label: "Horror", value: "HORROR" },
  { label: "Family", value: "FAMILY" },
  { label: "Unique", value: "UNIQUE" },
  { label: "Driving/Racing", value: "RACING" },
  { label: "Fighting", value: "FIGHTING" },
  { label: "Sport", value: "SPORTS" },
  { label: "Party", value: "PARTY" },
  { label: "Simulator", value: "SIMULATOR" },
  { label: "Brain Training", value: "BRAIN_TRAINING" },
  { label: "Music/Rhythm", value: "MUSIC/RHYTHM" },
  { label: "Educational", value: "EDUCATIONAL" },
  { label: "Adult", value: "ADULT" },
  { label: "Quiz", value: "QUIZ" },
  { label: "Fitness", value: "FITNESS" },
  { label: "Board Game", value: "BOARD_GAMES" },
];

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

function csvEscape(value) {
  const str = String(value ?? "");
  return `"${str.replaceAll('"', '""')}"`;
}

function cleanProductName(productName = "") {
  return productName
    .replace(/\(.*?\)/g, "")
    .trim()
    .replace(/\sfor\sPS4/i, "")
    .replace(/\sfor\sPS5/i, "")
    .replace(/\sfor\sPlayStation®4/i, "")
    .replace(/\sfor\sPlayStation®5/i, "")
    .replace(/\sPS4™ Edition/i, "")
    .replace(/\sPS5™ Edition/i, "")
    .replace(
      /\s*(\[|\s)(PS4 & PS5|PS4＆PS5|＆PS5)(\]|\s)*|\s*PS4&PS5|\s*PS4(™|®)?\s*&\s*PS5(™|®)?/g,
      ""
    )
    .trim()
    .replace(/\sPS4|\sPS5/g, "")
    .trim()
    .replace(/\s- PS4\/PS5\/PSVR2/g, "")
    .trim()
    .replace(/\s- PS5 & PS4|\s- PS4 & PS5/g, "")
    .trim()
    .replace(/\sPS4\?PS5/g, "")
    .trim();
}

function createSlug(productName = "", isPS4 = false, isPS5 = false) {
  const cleaned = cleanProductName(productName);

  const modifiedName = cleaned
    // remove symbols BEFORE normalize, otherwise ™ can become "TM"
    .replace(/[™®©]/g, "")

    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")

    // remove leftover text versions of symbols
    .replace(/\b(tm|r|c)\b/gi, "")

    // remove apostrophes
    .replace(/[’']/g, "")

    // remove store/branding noise
    .replace(/\bplaystation\s*hits\b/gi, "")
    .replace(/\bplaystationhits\b/gi, "")

    // remove standard/base edition noise
    .replace(/\bdigital edition\b/gi, "")
    .replace(/\bstandard edition\b/gi, "")
    .replace(/\bdigital\b/gi, "")
    .replace(/\bstandard\b/gi, "")

    // normalize separators
    .replace(/&/g, " and ")
    .replace(/[:\-–—_]+/g, " ")

    // clean remaining characters
    .replace(/[^a-zA-Z0-9+ ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  let slugPlatform = "";

  if (isPS4 && isPS5) {
    slugPlatform = "-ps4-ps5";
  } else if (isPS4) {
    slugPlatform = "-ps4";
  } else if (isPS5) {
    slugPlatform = "-ps5";
  } else {
    slugPlatform = "-ps4";
  }

  return `${modifiedName}${slugPlatform}`;
}

function getMasterImage(product) {
  const url =
    product.media?.find((m) => m.role === "MASTER")?.url ||
    product.media?.find((m) => m.type === "IMAGE")?.url ||
    product.media?.[0]?.url ||
    "";

  if (!url) return "";

  return url.includes("?")
    ? `${url}&w=200`
    : `${url}?w=200`;
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

async function fetchAllCategoryProducts(categoryId, filterBy) {
  const all = [];

  for (let offset = 0; ; offset += SIZE) {
    const products = await fetchCategoryPage(categoryId, offset, SIZE, filterBy);
    all.push(...products);

    console.log(`    offset ${offset}: ${products.length}`);

    if (products.length < SIZE) break;
  }

  return all;
}

function normalizeProduct(product, campaign, saleEnds, genreSet) {
  const price = product.price || {};
  const platforms = product.platforms || [];
  const title = product.name || "";
  const isPS4 = platforms.includes("PS4");
  const isPS5 = platforms.includes("PS5");

  return {
    SCORE: "",
    SaleEnds: saleEnds,
    SaleStarted: campaign.discoveredAt || "",
    PlusPrice: "",
    PlusDiscount: "",
    PlusPercentOff: "",
    Publisher: "",
    ReleaseDate: "",
    Genre: [...genreSet].join(", "),
    Price: price.basePrice || "",
    SalePrice: price.discountedPrice || price.basePrice || "",
    PercentOff: `${getDiscountPercent(product)}%`,
    Title: cleanProductName(title),
    OriginalTitle: title,
    Slug: createSlug(title, isPS4, isPS5),
    id: product.id,
    img: getMasterImage(product),
    PS4: isPS4 ? "TRUE" : "FALSE",
    PS5: isPS5 ? "TRUE" : "FALSE",
    Popularity: "",
    CampaignName: campaign.internalName,
    CampaignCategoryId: campaign.categoryId,
    Region: LOCALE,
    url: `https://store.playstation.com/${LOCALE}/product/${product.id}`,
  };
}

function toCsv(rows) {
  const headers = [
    "SCORE",
    "SaleEnds",
    "SaleStarted",
    "PlusPrice",
    "PlusDiscount",
    "PlusPercentOff",
    "Publisher",
    "ReleaseDate",
    "Genre",
    "Price",
    "SalePrice",
    "PercentOff",
    "Title",
    "OriginalTitle",
    "Slug",
    "id",
    "img",
    "PS4",
    "PS5",
    "Popularity",
    "CampaignName",
    "CampaignCategoryId",
    "Region",
    "url",
  ];

  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(",")),
  ];

  return lines.join("\n");
}

function dedupeRows(rows) {
  const map = new Map();

  for (const row of rows) {
    const existing = map.get(row.id);

    if (!existing) {
      map.set(row.id, row);
      continue;
    }

    const saleStarted =
      existing.SaleStarted || row.SaleStarted || "";

    // keep the campaign with the earlier SaleEnds
    if (
      row.SaleEnds &&
      (!existing.SaleEnds || row.SaleEnds < existing.SaleEnds)
    ) {
      map.set(row.id, {
        ...row,
        SaleStarted: saleStarted,
      });
    }
  }

  return [...map.values()];
}

async function scrapeCampaign(campaign) {
  console.log(`\nCampaign: ${campaign.internalName}`);

  const productMap = new Map();
  const productGenreMap = new Map();
  const campaignProductIds = new Set();

  for (const genre of GENRE_FACETS) {
    const filterBy = [
      ...STORE_DISPLAY_CLASSIFICATION_FILTERS,
      `productGenres:${genre.value}`,
    ];

    console.log(`  Genre: ${genre.label}`);

    let products;

    try {
      products = await fetchAllCategoryProducts(campaign.categoryId, filterBy);

      const beforeDiscountFilter = products.length;
      products = products.filter(isValidDiscount);

      console.log(
        `    100% off / blank filter: ${beforeDiscountFilter} -> ${products.length}`
      );
    } catch (err) {
      console.warn(`    Failed ${genre.label}: ${err.message}`);
      continue;
    }

    console.log(`    Total ${genre.label}: ${products.length}`);

    for (const product of products) {
      productMap.set(product.id, product);
      campaignProductIds.add(product.id);

      if (!productGenreMap.has(product.id)) {
        productGenreMap.set(product.id, new Set());
      }

      productGenreMap.get(product.id).add(genre.label);
    }
  }

  if (!campaignProductIds.size) {
    console.log("  No products found from genre filters.");
    return [];
  }

  const saleEnds = campaign.saleEnds || "";

console.log(`  SaleEnds from discovery cache: ${saleEnds || "not found"}`);

  const rows = [];

  for (const productId of campaignProductIds) {
    const product = productMap.get(productId);
    const genreSet = productGenreMap.get(productId) || new Set();

    rows.push(normalizeProduct(product, campaign, saleEnds, genreSet));
  }

  return rows;
}

async function main() {
  const {
    cache,
    campaignsToRun,
    campaignsToRemove,
  } = await discoverCampaigns();

  const existingRows = await readJsonFile(JSON_FILE, []);

  const removeCampaignIds = new Set(
    campaignsToRemove.map((c) => c.categoryId).filter(Boolean)
  );

  console.log(`Existing rows: ${existingRows.length}`);
  console.log(`Campaigns to run: ${campaignsToRun.length}`);
  console.log(`Campaigns to remove: ${removeCampaignIds.size}`);

  let rows = existingRows.filter(
    (row) => !removeCampaignIds.has(row.CampaignCategoryId)
  );

  console.log(`Rows after campaign cleanup: ${rows.length}`);

  if (campaignsToRun.length === 0) {
    await fs.writeFile(JSON_FILE, JSON.stringify(rows, null, 2), "utf8");
    await fs.writeFile(CSV_FILE, "\uFEFF" + toCsv(rows), "utf8");

    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");

    console.log("\nNo new campaigns to scrape.");
    console.log(`Final rows saved: ${rows.length}`);
    return;
  }

  const newRows = [];

  for (const campaign of campaignsToRun) {
    const campaignRows = await scrapeCampaign(campaign);
    newRows.push(...campaignRows);
  }

  rows = dedupeRows([...rows, ...newRows]);

  await fs.writeFile(JSON_FILE, JSON.stringify(rows, null, 2), "utf8");
  await fs.writeFile(CSV_FILE, "\uFEFF" + toCsv(rows), "utf8");

  const today = todayIso();

  for (const campaign of campaignsToRun) {
    if (campaign.internalName === "cat.gma.AllDeals") continue;
    const campaignRows = newRows.filter(
      (row) => row.CampaignCategoryId === campaign.categoryId
    );

    if (!campaignRows.length) continue;

    const saleEnds = campaignRows[0].SaleEnds || campaign.saleEnds || "";

    cache.active[campaign.categoryId] = {
      ...campaign,
      saleEnds,
      lastRan: today,
      region: LOCALE,
    };
  }

  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");

  console.log("\nRun complete.");
  console.log(`New rows scraped: ${newRows.length}`);
  console.log(`Final rows saved: ${rows.length}`);
  console.log(`JSON: ${JSON_FILE}`);
  console.log(`CSV: ${CSV_FILE}`);
  console.log(`Cache: ${CACHE_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});