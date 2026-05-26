const fs = require("fs");
const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");
const { BetaAnalyticsDataClient } = require("@google-analytics/data");

// =====================================================
// CONFIG
// =====================================================

const FILES = [
  "en-id_campaign_deals.json",
  "en-in_campaign_deals.json",
  "en-sg_campaign_deals.json",
  "en-tr_campaign_deals.json",
  "en-us_campaign_deals.json",
];

const GA_PROPERTY_ID = "272381607";
const GA_CREDENTIALS_FILE = "gcp_key.json";

const OUTPUT_FILE = "csvjsontr.csv";
const OUTPUT_JSON_FILE = "csvjsontr.json";
const METACRITIC_FILE = "metacritic_ps.csv";
const HLTB_FILE = "hltb_ps.json";

const OUTPUT_HEADERS = [
  "SCORE",
  "OpenCriticURL",
  "SaleEnds",
  "SaleStarted",
  "LowestPrice",
  "MainStory",
  "MainExtra",
  "Completionist",
  "PlusPrice",
  "PlusDiscount",
  "PlusPercentOff",
  "Publisher",
  "ReleaseDate",
  "genre",
  "PercentOff",
  "Title",
  "OriginalTitle",
  "Slug",
  "id",
  "Image",
  "IsPS4",
  "IsPS5",
  "Popularity",
  "CampaignName",
  "CampaignCategoryId",
  "Region",
  "url",
  "platform",
  "ESRBRating",
  "MexPrice",

  "idPrice",
  "idSalePrice",
  "inPrice",
  "inSalePrice",
  "sgPrice",
  "sgSalePrice",
  "trPrice",
  "trSalePrice",
  "usPrice",
  "usSalePrice",
];

// =====================================================

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function safeReadJsonRows(file) {
  if (!fs.existsSync(file)) {
    console.warn(`Missing file: ${file}`);
    return [];
  }

  return readJson(file);
}

function normalizeDate(value) {
  if (!value) return "";

  const str = String(value).trim();

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  // Handle M/D/YYYY or MM/DD/YYYY
  const usMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const month = usMatch[1].padStart(2, "0");
    const day = usMatch[2].padStart(2, "0");
    const year = usMatch[3];

    return `${year}-${month}-${day}`;
  }

  return str;
}

function extractSlugFromUrl(url = "") {
  return String(url).split("/").filter(Boolean).pop() || "";
}

async function loadPopularityMap() {
  if (!fs.existsSync(GA_CREDENTIALS_FILE)) {
    console.warn(`Missing GA credentials file: ${GA_CREDENTIALS_FILE}`);
    return new Map();
  }

  const analyticsDataClient = new BetaAnalyticsDataClient({
    keyFilename: GA_CREDENTIALS_FILE,
  });

  const [response] = await analyticsDataClient.runReport({
    property: `properties/${GA_PROPERTY_ID}`,
    dimensions: [{ name: "fullPageUrl" }],
    metrics: [{ name: "screenPageViews" }],
    dateRanges: [{ startDate: "3daysAgo", endDate: "today" }],
  });

  const popularityMap = new Map();

  for (const row of response.rows || []) {
    const fullPageUrl = row.dimensionValues?.[0]?.value || "";
    const slug = extractSlugFromUrl(fullPageUrl);
    const views = row.metricValues?.[0]?.value || "";

    if (slug) {
      popularityMap.set(slug, views);
    }
  }

  console.log(`GA popularity rows loaded: ${popularityMap.size}`);

  return popularityMap;
}

function readCsv(file) {
  return parse(fs.readFileSync(file, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
  });
}

function safeReadCsv(file) {
  if (!fs.existsSync(file)) {
    console.warn(`Missing optional file: ${file}`);
    return [];
  }

  return readCsv(file);
}

function safeReadJson(file) {
  if (!fs.existsSync(file)) {
    console.warn(`Missing optional file: ${file}`);
    return [];
  }

  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function cleanPrice(value) {
  if (!value) return "";

  return String(value)
    .replace(/[^\d.,-]/g, "")
    .replace(/,/g, "")
    .trim();
}

function toBoolInt(value) {
  return String(value).toLowerCase() === "true" ? "1" : "0";
}

function earlierDate(a, b) {
  if (!a) return b || "";
  if (!b) return a || "";

  return new Date(a) <= new Date(b) ? a : b;
}

function laterDate(a, b) {
  if (!a) return b || "";
  if (!b) return a || "";

  return new Date(a) >= new Date(b) ? a : b;
}

function getRegion(filename) {
  const match = filename.match(/^en-([a-z]{2})_/i);
  return match ? match[1].toLowerCase() : "";
}

function cleanTitleForMatch(value = "") {
  return String(value)
    .replace(/\(.*?\)/g, "")
    .replace(/[™®©]/g, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(tm|r|c)\b/gi, "")
    .replace(/[’']/g, "")
    .replace(/\bplaystation\s*hits\b/gi, "")
    .replace(/\bplaystationhits\b/gi, "")
    .replace(/\bdigital edition\b/gi, "")
    .replace(/\bstandard edition\b/gi, "")
    .replace(/\bdigital\b/gi, "")
    .replace(/\bstandard\b/gi, "")
    .replace(/\s+for\s+ps4\b/gi, "")
    .replace(/\s+for\s+ps5\b/gi, "")
    .replace(/\s+for\s+playstation\s*4\b/gi, "")
    .replace(/\s+for\s+playstation\s*5\b/gi, "")
    .replace(/\bps4\b/gi, "")
    .replace(/\bps5\b/gi, "")
    .replace(/&/g, " and ")
    .replace(/[:\-–—_]+/g, " ")
    .replace(/[^a-zA-Z0-9+ ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function createMatchSlug(value = "") {
  return cleanTitleForMatch(value).replace(/ /g, "-").replace(/-+/g, "-");
}

function createHltbKey(value = "") {
  return String(value)
    .replace(/\(.*?\)/g, "")
    .replace(/[™®©]/g, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(tm|r|c)\b/gi, "")
    .replace(/[’']/g, "")
    .replace(/\bplaystation\s*hits\b/gi, "")
    .replace(/\bplaystationhits\b/gi, "")
    .replace(/\bdigital\b/gi, "")
    .replace(/\bdigital edition\b/gi, "")
    .replace(/\bstandard edition\b/gi, "")
    .replace(/\bdigital\b/gi, "")
    .replace(/\bstandard\b/gi, "")
    .replace(/[^a-zA-Z0-9:+ ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// =====================================================
// LOAD METACRITIC
// =====================================================

const metacriticRows = safeReadCsv(METACRITIC_FILE);
const metacriticMap = new Map();

for (const row of metacriticRows) {
  const slug = row.Slug || row.slug;
  if (!slug) continue;

  metacriticMap.set(slug.trim().toLowerCase(), {
    score: row["Critic Score"] || "",
    url: `https://www.metacritic.com/game/${slug.trim().toLowerCase()}`,
  });
}

console.log(`Metacritic rows loaded: ${metacriticMap.size}`);

// =====================================================
// LOAD HLTB
// =====================================================

const hltbRows = safeReadJson(HLTB_FILE);
const hltbMap = new Map();

for (const item of hltbRows) {
  const name = item.game_name || "";
  const key = createHltbKey(name);

  if (!key) continue;

  hltbMap.set(key, {
    gameId: item.game_id ? `/game/${item.game_id}` : "",
    mainStory: item.comp_main ? Math.round(Number(item.comp_main) / 3600) : 0,
    mainExtra: item.comp_plus ? Math.round(Number(item.comp_plus) / 3600) : 0,
    completionist: item.comp_100 ? Math.round(Number(item.comp_100) / 3600) : 0,
  });
}

console.log(`HLTB rows loaded: ${hltbMap.size}`);

// =====================================================
// MERGE
// =====================================================

const merged = new Map();

for (const file of FILES) {
  console.log(`Processing ${file}...`);

  const region = getRegion(file);
  const rows = safeReadJsonRows(file);

  console.log(`  ${rows.length} rows`);

  for (const row of rows) {
    const rawSlug = row.Slug || row.slug;
    const titleForMatch = row.Title || row.OriginalTitle || rawSlug;
    const mergeKey = createMatchSlug(titleForMatch);

    if (!mergeKey) continue;

    const meta = metacriticMap.get(mergeKey) || {};
    const hltb = hltbMap.get(createHltbKey(titleForMatch)) || {};

    if (!merged.has(mergeKey)) {
      merged.set(mergeKey, {
        SCORE: meta.score || row.SCORE || "",
        OpenCriticURL: meta.url || "",
        SaleEnds: normalizeDate(row.SaleEnds || ""),
        SaleStarted: normalizeDate(row.SaleStarted || ""),
        LowestPrice: hltb.gameId || "",

        MainStory: hltb.mainStory || "",
        MainExtra: hltb.mainExtra || "",
        Completionist: hltb.completionist || "",

        PlusPrice: row.PlusPrice || "",
        PlusDiscount: row.PlusDiscount || "",
        PlusPercentOff: row.PlusPercentOff || "",

        Publisher: row.Publisher || "",
        ReleaseDate: "0000-00-00",
        genre: row.Genre || "",
        PercentOff: row.PercentOff || "",

        Title: row.Title || "",
        OriginalTitle: row.OriginalTitle || "",
        Slug: rawSlug || mergeKey,
        id: row.id || "",
        Image: row.img || "",

        IsPS4: toBoolInt(row.PS4 ?? row.IsPS4),
        IsPS5: toBoolInt(row.PS5 ?? row.IsPS5),

        Popularity: row.Popularity || "",
        CampaignName: row.CampaignName || "",
        CampaignCategoryId: row.CampaignCategoryId || "",
        Region: row.Region || "",
        url: row.url || "",

        platform: "Playstation",
        ESRBRating: "TRD",
        MexPrice: "null",
      });
    }

    const existing = merged.get(mergeKey);

    existing.SaleEnds = normalizeDate(
      earlierDate(existing.SaleEnds, row.SaleEnds)
    );

    existing.SaleStarted = normalizeDate(
      laterDate(existing.SaleStarted, row.SaleStarted)
    );

    existing.IsPS4 =
      existing.IsPS4 === "1" || toBoolInt(row.PS4 ?? row.IsPS4) === "1"
        ? "1"
        : "0";

    existing.IsPS5 =
      existing.IsPS5 === "1" || toBoolInt(row.PS5 ?? row.IsPS5) === "1"
        ? "1"
        : "0";

    if (!existing.SCORE && meta.score) {
      existing.SCORE = meta.score;
      existing.OpenCriticURL = meta.url;
    }

    if (!existing.MainStory && hltb.mainStory) {
      existing.MainStory = hltb.mainStory;
      existing.MainExtra = hltb.mainExtra;
      existing.Completionist = hltb.completionist;
    }

    if (!existing.LowestPrice && hltb.gameId) {
      existing.LowestPrice = hltb.gameId;
    }

    existing[`${region}Price`] = cleanPrice(row.Price);
    existing[`${region}SalePrice`] = cleanPrice(row.SalePrice);
  }
}

async function main() {
  const popularityMap = await loadPopularityMap();

  const outputRows = [...merged.values()]
    .map((row) => {
      row.Popularity = popularityMap.get(row.Slug) || row.Popularity || "";

      const ordered = {};

      for (const header of OUTPUT_HEADERS) {
        ordered[header] = row[header] ?? "";
      }

      return ordered;
    })
    .sort((a, b) => {
      const scoreA = parseInt(a.SCORE || 0, 10);
      const scoreB = parseInt(b.SCORE || 0, 10);

      return scoreB - scoreA;
    });

  const csv = stringify(outputRows, {
    header: true,
    columns: OUTPUT_HEADERS,
  });

  fs.writeFileSync(OUTPUT_FILE, "\uFEFF" + csv, "utf8");
  fs.writeFileSync(
    OUTPUT_JSON_FILE,
    JSON.stringify(outputRows, null, 2),
    "utf8"
  );

  console.log(`Merged rows: ${outputRows.length}`);
  console.log(`Saved CSV : ${OUTPUT_FILE}`);
  console.log(`Saved JSON: ${OUTPUT_JSON_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
