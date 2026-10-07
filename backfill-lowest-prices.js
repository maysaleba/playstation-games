#!/usr/bin/env node
const { execFileSync } = require('child_process');
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
const CURRENCY_BY_COUNTRY = { ID: 'IDR', IN: 'INR', SG: 'SGD', TR: 'TRY', US: 'USD', HK: 'HKD' };
const OUTPUT_FILE = path.resolve('playstation_lowest_prices.json');

const git = (...args) => execFileSync('git', args, {
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'ignore'],
});

function parsePrice(value, country) {
  if (value == null || value === '') return null;
  let text = String(value).replace(/[\s\u00a0\u202f]/g, '').replace(/[^0-9,.-]/g, '');
  if (!text || !/\d/.test(text)) return null;
  text = country === 'TR' ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isDiscount(row, sale, regular) {
  const percent = Number(String(row.PercentOff || '').replace('%', '').trim());
  return Number.isFinite(percent) && percent > 0 && sale < regular;
}

const commitLines = git(
  'log', '--reverse', '--format=%H %cs', '--', ...Object.values(REGION_FILES)
).split(/\r?\n/).filter(Boolean);
const lowest = {};
let snapshots = 0;
let observations = 0;

for (const line of commitLines) {
  const [hash, date] = line.split(' ');
  for (const [country, relativePath] of Object.entries(REGION_FILES)) {
    let rows;
    try {
      rows = JSON.parse(git('show', `${hash}:${relativePath}`));
    } catch {
      continue;
    }
    if (!Array.isArray(rows)) continue;
    snapshots++;

    for (const row of rows) {
      const slug = String(row.Slug || row.slug || '').trim().toLowerCase();
      const sale = parsePrice(row.SalePrice, country);
      const regular = parsePrice(row.Price, country);
      if (!slug || sale == null || regular == null || !isDiscount(row, sale, regular)) continue;

      lowest[slug] = lowest[slug] || {};
      const previous = lowest[slug][country];
      if (!previous || previous.currency !== CURRENCY_BY_COUNTRY[country] || sale < Number(previous.price)) {
        lowest[slug][country] = { price: sale, currency: CURRENCY_BY_COUNTRY[country], date };
        observations++;
      }
    }
  }
  console.log(`Processed ${hash.slice(0, 7)} (${date})`);
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(lowest, null, 2), 'utf8');
const gameCount = Object.keys(lowest).length;
const recordCount = Object.values(lowest).reduce((sum, countries) => sum + Object.keys(countries).length, 0);
console.log(`Backfill complete: ${gameCount} games, ${recordCount} regional lows; ${snapshots} regional snapshots, ${observations} low updates.`);
