// fetch-japanese-met.js
// Fetches Japanese pottery from the Met Collection API, classifies by period.
// Run: node fetch-japanese-met.js
// Writes: japanese-met-data.js

const MET_BASE = 'https://collectionapi.metmuseum.org/public/collection/v1';

const PERIODS = [
  { id: 'jomon',      label: 'Jōmon',              start: -10500, end:  -300 },
  { id: 'yayoi',      label: 'Yayoi',               start:   -300, end:   300 },
  { id: 'nara-heian', label: 'Nara & Heian',         start:    710, end:  1185 },
  { id: 'kamakura',   label: 'Kamakura & Muromachi', start:   1185, end:  1573 },
  { id: 'momoyama',   label: 'Momoyama',             start:   1573, end:  1615 },
  { id: 'edo',        label: 'Edo',                  start:   1615, end:  1868 },
  { id: 'meiji',      label: 'Meiji',                start:   1868, end:  1912 },
];

// Parse period string from the Met's period field
function periodFromString(periodStr) {
  if (!periodStr) return null;
  const p = periodStr.toLowerCase();
  if (p.includes('jōmon') || p.includes('jomon')) return 'jomon';
  if (p.includes('yayoi')) return 'yayoi';
  if (p.includes('nara') || p.includes('heian') || p.includes('asuka')) return 'nara-heian';
  if (p.includes('kamakura') || p.includes('muromachi') || p.includes('nanboku') || p.includes('namboku')) return 'kamakura';
  if (p.includes('momoyama') || p.includes('azuchi')) return 'momoyama';
  if (p.includes('edo') || p.includes('tokugawa')) return 'edo';
  if (p.includes('meiji') || p.includes('taisho') || p.includes('taishō') || p.includes('showa') || p.includes('modern')) return 'meiji';
  return null;
}

// Fallback: classify by date overlap
function periodFromDates(begin, end) {
  if (begin == null && end == null) return null;
  const s = begin ?? end;
  const e = end ?? begin;

  let bestId = null, bestOverlap = 0;
  for (const p of PERIODS) {
    const overlap = Math.min(e, p.end) - Math.max(s, p.start);
    if (overlap > bestOverlap) { bestOverlap = overlap; bestId = p.id; }
  }
  if (bestId) return bestId;

  // Nearest by midpoint
  const mid = (s + e) / 2;
  let nearest = PERIODS[0], minDist = Infinity;
  for (const p of PERIODS) {
    const dist = Math.abs(mid - (p.start + p.end) / 2);
    if (dist < minDist) { minDist = dist; nearest = p; }
  }
  return nearest.id;
}

const CERAMIC_TERMS = [
  'porcelain', 'stoneware', 'earthenware', 'ceramic', 'pottery',
  'terracotta', 'glazed', 'faience', 'biscuit', 'slip', 'ware',
];

function isCeramic(medium) {
  const m = (medium || '').toLowerCase();
  return CERAMIC_TERMS.some(k => m.includes(k));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status === 403) {
        const wait = 2000 * (i + 1);
        process.stdout.write(` [rate limit, waiting ${wait}ms]`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i < retries - 1) await sleep(600 * (i + 1));
      else throw e;
    }
  }
}

async function collectIDs() {
  const searches = [
    'japan ceramic',
    'japan stoneware',
    'japan earthenware',
    'japan porcelain',
    'japan pottery',
    'Jomon',
    'Yayoi',
    'Raku',
    'Bizen',
    'Shigaraki',
    'Mino ware',
    'Seto ware',
    'Arita',
    'Imari',
    'Kakiemon',
    'Kutani',
    'Oribe',
    'Hagi ware',
    'Kenzan',
    'Ninsei',
  ];

  const allIDs = new Set();
  for (const q of searches) {
    process.stdout.write(`Searching "${q}"...`);
    const data = await fetchJSON(
      `${MET_BASE}/search?departmentId=6&hasImages=true&q=${encodeURIComponent(q)}`
    );
    (data.objectIDs || []).forEach(id => allIDs.add(id));
    console.log(` ${data.total} results (${allIDs.size} unique so far)`);
    await sleep(700);
  }

  return [...allIDs];
}

async function fetchAllObjects(ids) {
  const BATCH = 5;
  const DELAY = 350;
  const results = [];
  const total = ids.length;

  for (let i = 0; i < total; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const batch = await Promise.all(
      slice.map(id => fetchJSON(`${MET_BASE}/objects/${id}`).catch(() => null))
    );

    for (const o of batch) {
      if (!o || !o.primaryImageSmall) continue;
      if (!isCeramic(o.medium)) continue;
      // Must be Japanese
      const culture = (o.culture || '').toLowerCase();
      if (!culture.includes('japan')) continue;
      results.push(o);
    }

    if ((i / BATCH) % 50 === 0) {
      const pct = Math.round((i / total) * 100);
      console.log(`  ${pct}% — ${i}/${total} fetched, ${results.length} kept`);
    }

    await sleep(DELAY);
  }

  return results;
}

function groupByPeriod(objects) {
  const groups = {};
  for (const p of PERIODS) groups[p.id] = [];
  groups.other = [];

  for (const o of objects) {
    const bucket =
      periodFromString(o.period) ||
      periodFromDates(o.objectBeginDate, o.objectEndDate) ||
      'other';

    groups[bucket].push({
      objectID:          o.objectID,
      title:             o.title || 'Untitled',
      period:            o.period || '',
      objectDate:        o.objectDate || '',
      objectBeginDate:   o.objectBeginDate,
      objectEndDate:     o.objectEndDate,
      medium:            (o.medium || '').split(';')[0].trim(),
      primaryImageSmall: o.primaryImageSmall,
      objectURL:         o.objectURL,
      source:            'met',
    });
  }

  // Sort each group: by objectBeginDate
  for (const arr of Object.values(groups)) {
    arr.sort((a, b) => (a.objectBeginDate ?? 9999) - (b.objectBeginDate ?? 9999));
  }

  return groups;
}

async function main() {
  const fs = await import('fs');

  console.log('=== Phase 1: Collecting IDs ===');
  const ids = await collectIDs();
  console.log(`Total unique IDs: ${ids.length}\n`);

  console.log('=== Phase 2: Fetching object details ===');
  const objects = await fetchAllObjects(ids);
  console.log(`\nFetched ${objects.length} Japanese ceramic objects\n`);

  console.log('=== Phase 3: Classifying by period ===');
  const grouped = groupByPeriod(objects);
  for (const [id, arr] of Object.entries(grouped)) {
    if (arr.length) console.log(`  ${id.padEnd(16)}: ${arr.length} objects`);
  }

  const js = `// Auto-generated by fetch-japanese-met.js
// ${new Date().toISOString()} — ${objects.length} total objects
// Re-run: node fetch-japanese-met.js
const JAPANESE_MET_DATA = ${JSON.stringify(grouped, null, 2)};
`;

  await fs.promises.writeFile('japanese-met-data.js', js, 'utf8');
  console.log(`\nWrote japanese-met-data.js`);
}

main().catch(console.error);
