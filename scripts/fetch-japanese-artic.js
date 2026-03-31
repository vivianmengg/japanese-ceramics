// fetch-japanese-artic.js
// Fetches Japanese ceramics from the Art Institute of Chicago API.
// No API key needed. Free open access. Rate limit: 60 req/min.
// Run: node fetch-japanese-artic.js
// Writes: japanese-artic-data.js

import { writeFile } from 'fs/promises';

const BASE   = 'https://api.artic.edu/api/v1';
const OUTPUT = './japanese-artic-data.js';
const FIELDS = 'id,title,date_display,date_start,date_end,medium_display,place_of_origin,artwork_type_title,image_id';

const PERIODS = [
  { id: 'jomon',      label: 'Jōmon',              begin: -10500, end:  -300 },
  { id: 'yayoi',      label: 'Yayoi',               begin:   -300, end:   300 },
  { id: 'nara-heian', label: 'Nara & Heian',         begin:    710, end:  1185 },
  { id: 'kamakura',   label: 'Kamakura & Muromachi', begin:   1185, end:  1573 },
  { id: 'momoyama',   label: 'Momoyama',             begin:   1573, end:  1615 },
  { id: 'edo',        label: 'Edo',                  begin:   1615, end:  1868 },
  { id: 'meiji',      label: 'Meiji',                begin:   1868, end:  1912 },
];

function periodFromDates(begin, end) {
  if (begin == null || end == null) return null;
  if (begin === 0 && end > 500) return null;
  const s = begin, e = end;
  let bestId = null, bestOverlap = 0;
  for (const p of PERIODS) {
    const overlap = Math.min(e, p.end) - Math.max(s, p.begin);
    if (overlap > bestOverlap) { bestOverlap = overlap; bestId = p.id; }
  }
  if (bestId) return bestId;
  const mid = (s + e) / 2;
  let nearest = PERIODS[0], minDist = Infinity;
  for (const p of PERIODS) {
    const dist = Math.abs(mid - (p.begin + p.end) / 2);
    if (dist < minDist) { minDist = dist; nearest = p; }
  }
  return nearest.id;
}

const JAPANESE_ORIGINS = [
  'japan', 'japanese', 'kyoto', 'edo', 'osaka', 'arita', 'kyushu',
  'honshu', 'satsuma', 'nagasaki', 'bizen', 'mino', 'hagi', 'seto',
  'shigaraki', 'tokoname', 'echizen',
];

function isJapaneseOrigin(place) {
  if (!place) return false;
  const p = place.toLowerCase();
  return JAPANESE_ORIGINS.some(o => p.includes(o));
}

const EXCLUDE_MEDIUM = [
  /\bink\b/i, /\bsilk\b/i, /\bpaper\b/i, /\bbrocade\b/i,
  /\btapestry\b/i, /\bwoodblock\b/i, /\bprint\b/i,
  /\bbronze\b/i, /\bcopper\b/i, /\bgold\b/i, /\bsilver\b/i,
  /\biron\b/i, /\bjade\b/i, /\blacquer\b/i, /\bcloisonn/i,
  /\bglass\b/i,
];

function isCeramicMedium(medium) {
  if (!medium) return false;
  const hasCeramic = /porcelain|stoneware|earthenware|ceramic|terracotta|terra.cotta|bisque|faience|tin.glaze|slip.ware|celadon|fritware|lead.glaze/i.test(medium);
  if (!hasCeramic) return false;
  const primary = medium.split(/[,;]/)[0];
  return !EXCLUDE_MEDIUM.some(re => re.test(primary));
}

async function searchPage(query, offset = 0) {
  const body = { query, fields: FIELDS.split(','), limit: 100, offset };
  const res = await fetch(`${BASE}/artworks/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'AIC-User-Agent': 'japanese-pottery-research/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return { hits: data.data || [], total: data.pagination?.total || 0 };
}

const JAPAN_TERMS = [
  'japan', 'japanese', 'kyoto', 'arita', 'satsuma', 'kyushu',
  'imari', 'bizen', 'shigaraki', 'mino', 'hagi',
];

async function fetchPeriod(period) {
  const query = {
    bool: {
      must: [
        { term: { is_public_domain: true } },
        { exists: { field: 'image_id' } },
        { bool: {
          should: [
            { range: { date_start: { gte: period.begin, lte: period.end } } },
            { range: { date_end:   { gte: period.begin, lte: period.end } } },
          ],
          minimum_should_match: 1,
        }},
        { multi_match: {
          query: JAPAN_TERMS.join(' '),
          fields: ['place_of_origin', 'term_titles', 'style_titles'],
          operator: 'or',
        }},
      ],
    },
  };

  const hits = [];
  let offset = 0, total = Infinity;
  while (offset < total) {
    const { hits: page, total: t } = await searchPage(query, offset);
    total = t;
    hits.push(...page);
    if (page.length < 100) break;
    offset += 100;
    await new Promise(r => setTimeout(r, 300));
    process.stdout.write(`\r  ${period.label}: ${hits.length}/${total}...`);
  }
  return { hits, total };
}

// Ware-type queries to catch objects not labelled with Japan origin
const WARE_QUERIES = [
  'imari', 'kakiemon', 'nabeshima', 'satsuma', 'bizen',
  'shigaraki stoneware', 'raku ware', 'shino ware', 'oribe ware',
  'kutani', 'kenzan', 'arita porcelain', 'jomon',
];

async function fetchWareQuery(q, seen) {
  const query = {
    bool: {
      must: [
        { term: { is_public_domain: true } },
        { exists: { field: 'image_id' } },
        { multi_match: { query: q, fields: ['title', 'medium_display', 'term_titles', 'style_titles'] } },
      ],
    },
  };
  const hits = [];
  let offset = 0, total = Infinity;
  while (offset < total && offset < 500) {
    const { hits: page, total: t } = await searchPage(query, offset);
    total = t;
    for (const h of page) { if (!seen.has(h.id)) hits.push(h); }
    if (page.length < 100) break;
    offset += 100;
    await new Promise(r => setTimeout(r, 300));
  }
  return hits;
}

async function main() {
  console.log('Fetching Art Institute of Chicago — Japanese Ceramics\n');

  const seen = new Set();
  const raw = [];

  console.log('Pass 1: date-range queries per period');
  for (const period of PERIODS) {
    process.stdout.write(`  ${period.label}...`);
    try {
      const { hits, total } = await fetchPeriod(period);
      let added = 0;
      for (const h of hits) {
        if (!seen.has(h.id)) { seen.add(h.id); raw.push(h); added++; }
      }
      console.log(`\r  ${period.label}: ${total} hits, ${added} new (${raw.length} total)`);
    } catch(e) {
      console.log(` ERROR: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }

  console.log('\nPass 2: ware-type queries');
  for (const q of WARE_QUERIES) {
    process.stdout.write(`  "${q}"...`);
    try {
      const hits = await fetchWareQuery(q, seen);
      for (const h of hits) { seen.add(h.id); raw.push(h); }
      console.log(` ${hits.length} new (${raw.length} total)`);
    } catch(e) {
      console.log(` ERROR: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nRaw objects collected: ${raw.length}`);
  console.log('Filtering to Japanese ceramics...\n');

  const byPeriod = Object.fromEntries(PERIODS.map(p => [p.id, []]));
  let skippedOrigin = 0, skippedMedium = 0, skippedPeriod = 0, kept = 0;

  for (const o of raw) {
    if (!isJapaneseOrigin(o.place_of_origin)) { skippedOrigin++; continue; }
    if (!isCeramicMedium(o.medium_display))   { skippedMedium++; continue; }

    const period = periodFromDates(o.date_start, o.date_end);
    if (!period) { skippedPeriod++; continue; }

    byPeriod[period].push({
      objectID:          o.id,
      title:             o.title || 'Untitled',
      culture:           o.place_of_origin || 'Japan',
      objectDate:        o.date_display || '',
      objectBeginDate:   o.date_start ?? null,
      objectEndDate:     o.date_end   ?? null,
      medium:            o.medium_display || '',
      objectURL:         `https://www.artic.edu/artworks/${o.id}`,
      primaryImageSmall: `https://www.artic.edu/iiif/2/${o.image_id}/full/400,/0/default.jpg`,
      source:            'artic',
    });
    kept++;
  }

  console.log('Filtering:');
  console.log(`  Kept:           ${kept}`);
  console.log(`  Not Japanese:   ${skippedOrigin}`);
  console.log(`  Not ceramic:    ${skippedMedium}`);
  console.log(`  No period:      ${skippedPeriod}`);
  console.log('\nBy period:');
  PERIODS.forEach(p => console.log(`  ${p.label.padEnd(22)} ${byPeriod[p.id].length}`));

  const out = `// Auto-generated by fetch-japanese-artic.js
// ${new Date().toISOString()} — ${kept} objects
// Art Institute of Chicago Open Access — Japanese Ceramics
// To refresh: node fetch-japanese-artic.js
const JAPANESE_ARTIC_DATA = ${JSON.stringify(byPeriod)};
`;
  await writeFile(OUTPUT, out);
  console.log(`\nWrote ${OUTPUT} (${Math.round(Buffer.byteLength(out) / 1024)} KB)`);
}

main().catch(console.error);
