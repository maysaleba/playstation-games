#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const REGION_FILES = {
  ID: 'en-id_campaign_deals.json',
  IN: 'en-in_campaign_deals.json',
  SG: 'en-sg_campaign_deals.json',
  TR: 'en-tr_campaign_deals.json',
  US: 'en-us_campaign_deals.json',
  HK: 'en-hk_campaign_deals.json',
};
const CURRENCY_BY_COUNTRY = {
  ID: 'IDR',
  IN: 'INR',
  SG: 'SGD',
  TR: 'TRY',
  US: 'USD',
  HK: 'HKD',
};
const LOWEST_FILE = path.resolve('playstation_lowest_prices.json');
const STATUS_FILE = path.resolve('playstation_current_sale_status.json');
const CATALOG_FILE = path.resolve('csvjsontr.json');
const FX_URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (fs.existsSync(file)) throw new Error(`Invalid JSON in ${file}: ${error.message}`);
    return fallback;
  }
}

function parsePrice(value, country) {
  if (value == null || value === '') return null;
  let text = String(value).replace(/[\s\u00a0\u202f]/g, '').replace(/[^0-9,.-]/g, '');
  if (!text || !/\d/.test(text)) return null;

  if (country === 'TR') {
    text = text.replace(/\./g, '').replace(',', '.');
  } else {
    text = text.replace(/,/g, '');
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function dateTime(value, endOfDay = false) {
  if (!value) return NaN;
  const text = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : text;
  return Date.parse(normalized);
}

function isDiscount(row, sale, regular) {
  const percent = Number(String(row.PercentOff || '').replace('%', '').trim());
  return Number.isFinite(percent) && percent > 0 && sale < regular;
}

function activeOffer(row, country, now) {
  const salePrice = parsePrice(row.SalePrice, country);
  const regularPrice = parsePrice(row.Price, country);
  if (salePrice == null || regularPrice == null || !isDiscount(row, salePrice, regularPrice)) return null;

  const starts = dateTime(row.SaleStarted);
  const ends = dateTime(row.SaleEnds, true);
  if (Number.isFinite(starts) && starts > now) return null;
  if (!Number.isFinite(ends) || ends <= now) return null;

  return { price: salePrice, currency: CURRENCY_BY_COUNTRY[country], saleStart: row.SaleStarted || null, saleEnd: row.SaleEnds || null };
}

async function fetchUsdRates() {
  const response = await fetch(FX_URL, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Exchange-rate request failed: HTTP ${response.status}`);
  const data = await response.json();
  if (!data?.usd || !Number.isFinite(Number(data.usd.php)) || Number(data.usd.php) <= 0) {
    throw new Error('Exchange-rate response has no valid USD→PHP rate');
  }
  return { rates: data.usd, date: data.date || 'unknown' };
}

function toPhp(amount, currency, rates) {
  const unitsPerUsd = Number(rates[String(currency || '').toLowerCase()]);
  const phpPerUsd = Number(rates.php);
  if (!Number.isFinite(amount) || !Number.isFinite(unitsPerUsd) || unitsPerUsd <= 0 || !Number.isFinite(phpPerUsd)) return null;
  return (amount / unitsPerUsd) * phpPerUsd;
}

function loadRegionalOffers() {
  const offers = new Map();
  for (const [country, file] of Object.entries(REGION_FILES)) {
    const rows = readJson(file, []);
    if (!Array.isArray(rows)) throw new Error(`Expected a JSON array in ${file}`);
    for (const row of rows) {
      const slug = String(row.Slug || row.slug || '').trim().toLowerCase();
      const sale = parsePrice(row.SalePrice, country);
      const regular = parsePrice(row.Price, country);
      if (!slug || sale == null || regular == null || !isDiscount(row, sale, regular)) continue;
      const observations = offers.get(slug) || {};
      observations[country] = {
        price: sale,
        currency: CURRENCY_BY_COUNTRY[country],
        saleStart: row.SaleStarted || null,
        saleEnd: row.SaleEnds || null,
        active: Boolean(activeOffer(row, country, Date.now())),
      };
      offers.set(slug, observations);
    }
  }
  return offers;
}

function computeGlobalCheapest(lowest, offers, rates) {
  const cheapest = {};
  for (const [slug, countries] of Object.entries(lowest)) {
    for (const [country, record] of Object.entries(countries || {})) {
      const php = toPhp(Number(record?.price), record?.currency, rates);
      if (php != null) cheapest[slug] = Math.min(cheapest[slug] ?? Infinity, php);
    }
  }
  for (const [slug, countries] of offers) {
    for (const [country, offer] of Object.entries(countries)) {
      if (!offer.active) continue;
      const php = toPhp(offer.price, offer.currency, rates);
      if (php != null) cheapest[slug] = Math.min(cheapest[slug] ?? Infinity, php);
    }
  }
  return cheapest;
}

async function main() {
  const lowest = readJson(LOWEST_FILE, {});
  const catalog = readJson(CATALOG_FILE, []);
  if (!lowest || Array.isArray(lowest) || typeof lowest !== 'object' || !Array.isArray(catalog)) {
    throw new Error('Expected lowest-price object and merged catalog array');
  }

  const offers = loadRegionalOffers();
  const { rates, date: rateDate } = await fetchUsdRates();
  const now = Date.now();
  const globalCheapest = computeGlobalCheapest(lowest, offers, rates);
  const today = new Date().toISOString().slice(0, 10);
  let added = 0, newLows = 0, matches = 0, notLows = 0, unknown = 0;
  const observedActive = new Set();

  for (const [slug, countries] of offers) {
    lowest[slug] = lowest[slug] || {};
    for (const [country, offer] of Object.entries(countries)) {
      let record = lowest[slug][country];
      const sameOffer = offer.active && record?.currentSale &&
        record.currentSale.saleStart === offer.saleStart &&
        record.currentSale.saleEnd === offer.saleEnd &&
        Number(record.currentSale.price) === offer.price &&
        record.currentSale.currency === offer.currency;
      const historicReference = sameOffer && record.currentSale.statusRule === 'ps_global_php_v1'
        ? record.currentSale.historicPrice == null ? Number(record.price) : Number(record.currentSale.historicPrice)
        : record && record.currency === offer.currency ? Number(record.price) : null;

      if (!record) {
        record = lowest[slug][country] = { price: offer.price, currency: offer.currency, date: today };
        added++;
      }

      if (offer.active) {
        const offerPhp = toPhp(offer.price, offer.currency, rates);
        const cheapestPhp = globalCheapest[slug];
        let status;
        if (offerPhp == null || cheapestPhp == null) {
          status = 'unknown';
          unknown++;
        } else if (offerPhp > cheapestPhp + 0.01) {
          status = 'not_low';
          notLows++;
        } else if (record.currency !== offer.currency || !Number.isFinite(historicReference)) {
          status = 'unknown';
          unknown++;
        } else if (offer.price < historicReference) {
          status = 'new_low';
          newLows++;
        } else if (offer.price === historicReference) {
          status = 'matches_low';
          matches++;
        } else {
          status = 'not_low';
          notLows++;
        }

        record.currentSale = {
          price: offer.price,
          currency: offer.currency,
          status,
          statusRule: 'ps_global_php_v1',
          historicPrice: Number.isFinite(historicReference) ? historicReference : null,
          saleStart: offer.saleStart,
          saleEnd: offer.saleEnd,
        };
        observedActive.add(`${slug}\0${country}`);
      }

      if (record.currency === offer.currency && offer.price < Number(record.price)) {
        record.price = offer.price;
        record.currency = offer.currency;
        record.date = today;
      }
    }
  }

  for (const [slug, countries] of Object.entries(lowest)) {
    for (const [country, record] of Object.entries(countries || {})) {
      if (record?.currentSale && !observedActive.has(`${slug}\0${country}`)) delete record.currentSale;
    }
  }

  const catalogSlugs = new Set(catalog.map(row => String(row.Slug || '').trim().toLowerCase()).filter(Boolean));
  const statusFeed = Object.fromEntries([...catalogSlugs].map(slug => [slug, {}]));
  for (const [slug, countries] of Object.entries(lowest)) {
    if (!catalogSlugs.has(slug)) continue;
    for (const [country, record] of Object.entries(countries || {})) {
      if (record?.currentSale?.status) statusFeed[slug][country] = record.currentSale.status;
    }
  }

  fs.writeFileSync(LOWEST_FILE, JSON.stringify(lowest, null, 2), 'utf8');
  fs.writeFileSync(STATUS_FILE, JSON.stringify(statusFeed), 'utf8');
  console.log(`Historical lows: +${added} new games/regions, ${newLows} new lows, ${matches} matches, ${notLows} not lows, ${unknown} unknown`);
  console.log(`FX rates date: ${rateDate}; published status games: ${Object.keys(statusFeed).length}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
