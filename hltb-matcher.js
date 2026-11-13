// Prefer the actual HLTB title before trying a store edition's base game.
function normalizeTitle(value = "") {
  return String(value)
    .replace(/\(.*?\)/g, "")
    .replace(/[™®©]/g, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/\bplaystation\s*hits\b/gi, " ")
    .replace(/\b(?:for\s+)?(?:ps[45]|playstation\s*[45])(?:\s*[/&+]\s*(?:ps[45]|playstation\s*[45]))?\b/gi, " ")
    .replace(/&/g, " and ")
    .replace(/[:\-–—_]/g, " ")
    .replace(/[^a-zA-Z0-9+ ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function baseEditionTitle(title) {
  // Only strip a trailing, explicitly named edition; not arbitrary subtitles,
  // bundles, remasters, or words such as "Ultimate" in a game's name.
  return title.replace(/\s+(?:(?:digital|standard|deluxe|ultimate|definitive|complete|collectors?|gold|premium|special|enhanced|legendary|game of the year|goty)\s+)+edition$/, "").trim();
}

function createHltbMatcher(rows) {
  const entries = [];
  const exact = new Map();
  const byToken = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const title = normalizeTitle(row?.game_name);
    if (!title) continue;
    const entry = { row, title, tokens: new Set(title.split(" ")), index: entries.length };
    entries.push(entry);
    if (!exact.has(title)) exact.set(title, entry);
    for (const token of entry.tokens) {
      if (!byToken.has(token)) byToken.set(token, []);
      byToken.get(token).push(entry);
    }
  }

  function find(title) {
    if (!title) return null;
    if (exact.has(title)) return exact.get(title).row;
    const tokens = new Set(title.split(" "));
    const candidates = new Set();
    for (const token of tokens) {
      for (const entry of byToken.get(token) || []) candidates.add(entry);
    }
    let best = null;
    let bestScore = 0;
    // Keep source order for ties, like the Switch matcher.
    for (const entry of [...candidates].sort((a, b) => a.index - b.index)) {
      let intersection = 0;
      for (const token of tokens) if (entry.tokens.has(token)) intersection++;
      const score = intersection / (tokens.size + entry.tokens.size - intersection);
      if (score > bestScore) {
        best = entry.row;
        bestScore = score;
        if (score === 1) break;
      }
    }
    return bestScore >= 0.9 ? best : null;
  }

  return (title) => {
    const normalized = normalizeTitle(title);
    const baseTitle = baseEditionTitle(normalized);
    const match = find(normalized) || (baseTitle !== normalized ? find(baseTitle) : null);
    return {
      LowestPrice: match?.game_id ? `/game/${match.game_id}` : "",
      MainStory: Math.round((Number(match?.comp_main) || 0) / 3600) || "",
      MainExtra: Math.round((Number(match?.comp_plus) || 0) / 3600) || "",
      Completionist: Math.round((Number(match?.comp_100) || 0) / 3600) || "",
    };
  };
}

module.exports = { createHltbMatcher };