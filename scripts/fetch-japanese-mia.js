// fetch-japanese-mia.js
// Fetches Japanese ceramics from the Minneapolis Institute of Art (Mia).
// API: https://search.artsmia.org (no key required, CC0)
// Run: node fetch-japanese-mia.js
// Writes: japanese-mia-data.js

import { writeFile } from 'fs/promises';

const SEARCH_BASE = 'https://search.artsmia.org';
const IMAGE_BASE  = 'http://api.artsmia.org/images';
const OUTPUT      = './japanese-mia-data.js';
const PAGE_SIZE   = 100;

const PERIODS = [
  { id: 'jomon',      start: -10500, end:  -300 },
  { id: 'yayoi',      start:   -300, end:   300 },
  { id: 'nara-heian', start:    710, end:  1185 },
  { id: 'kamakura',   start:   1185, end:  1573 },
  { id: 'momoyama',   start:   1573, end:  1615 },
  { id: 'edo',        start:   1615, end:  1868 },
  { id: 'meiji',      start:   1868, end:  1912 },
];

function periodFromString(s) {
  if (!s) return null;
  const p = s.toLowerCase();
  if (p.includes('jōmon') || p.includes('jomon'))                           return 'jomon';
  if (p.includes('yayoi'))                                                   return 'yayoi';
  if (p.includes('nara') || p.includes('heian') || p.includes('asuka'))     return 'nara-heian';
  if (p.includes('kamakura') || p.includes('muromachi') || p.includes('nanboku') ||
      p.includes('namboku') || p.includes('ashikaga'))                       return 'kamakura';
  if (p.includes('momoyama') || p.includes('azuchi'))                       return 'momoyama';
  if (p.includes('edo') || p.includes('tokugawa'))                          return 'edo';
  if (p.includes('meiji') || p.includes('taisho') || p.includes('taishō') ||
      p.includes('showa') || p.includes('shōwa') || p.includes('modern'))   return 'meiji';
  return null;
}

// Parse a date string like "1615–1868", "17th century", "ca. 1800", "1800s"
function periodFromDateString(dated) {
  if (!dated) return null;
  const bce = /bce|b\.c/i.test(dated);

  // Range: "1615–1868" or "1615-1868"
  const rangeM = dated.match(/(\d{3,4})\s*[–\-]\s*(\d{3,4})/);
  if (rangeM) {
    const mid = (parseInt(rangeM[1]) + parseInt(rangeM[2])) / 2;
    return periodFromYear(bce ? -mid : mid);
  }
  // Century: "17th century" → midpoint of 1600s
  const centuryM = dated.match(/(\d+)(?:st|nd|rd|th)\s*century/i);
  if (centuryM) {
    const mid = (parseInt(centuryM[1]) - 1) * 100 + 50;
    return periodFromYear(bce ? -mid : mid);
  }
  // Decade: "1800s"
  const decadeM = dated.match(/(\d{3,4})s\b/);
  if (decadeM) return periodFromYear(bce ? -parseInt(decadeM[1]) : parseInt(decadeM[1]));
  // Single year or "ca. YYYY"
  const yearM = dated.match(/(\d{3,4})/);
  if (yearM) return periodFromYear(bce ? -parseInt(yearM[1]) : parseInt(yearM[1]));
  return null;
}

function periodFromYear(year) {
  for (const p of PERIODS) {
    if (year >= p.start && year <= p.end) return p.id;
  }
  let best = null, minDist = Infinity;
  for (const p of PERIODS) {
    const dist = Math.abs(year - (p.start + p.end) / 2);
    if (dist < minDist) { minDist = dist; best = p.id; }
  }
  return best;
}

async function fetchPage(query, from) {
  const url = `${SEARCH_BASE}/${encodeURIComponent(query)}?size=${PAGE_SIZE}&from=${from}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} at from=${from}`);
  return res.json();
}

async function fetchAllForQuery(query) {
  const first = await fetchPage(query, 0);
  const total = Math.min(first.hits?.total?.value ?? 0, 10000);
  const hits = [...(first.hits?.hits ?? [])];
  const pages = Math.ceil(total / PAGE_SIZE);
  for (let p = 1; p < pages; p++) {
    process.stdout.write(`\r  "${query}" — page ${p + 1}/${pages}...`);
    const data = await fetchPage(query, p * PAGE_SIZE);
    hits.push(...(data.hits?.hits ?? []));
    await new Promise(r => setTimeout(r, 150));
  }
  if (pages > 1) process.stdout.write(`\r  "${query}" — ${hits.length} fetched (${total} total)\n`);
  else console.log(`  "${query}" — ${hits.length} fetched`);
  return hits;
}

async function main() {
  console.log('Fetching Minneapolis Institute of Art — Japanese Ceramics\n');

  // Two queries to maximise coverage: ceramics + pottery classifications
  const raw = [];
  const seen = new Set();
  for (const query of [
    'country:Japan AND classification:Ceramics',
    'country:Japan AND classification:Pottery',
    'country:Japan AND department:"Asian Art" AND medium:stoneware',
    'country:Japan AND department:"Asian Art" AND medium:porcelain',
    'country:Japan AND department:"Asian Art" AND medium:earthenware',
  ]) {
    const hits = await fetchAllForQuery(query);
    for (const hit of hits) {
      const id = hit._source?.id;
      if (id && !seen.has(id)) { seen.add(id); raw.push(hit._source); }
    }
  }
  console.log(`\n  ${raw.length} unique raw records\n`);

  const groups = {};
  for (const p of PERIODS) groups[p.id] = [];
  groups.other = [];

  let usedDynasty = 0, usedDated = 0, noImage = 0, noPeriod = 0;

  for (const obj of raw) {
    if (obj.image !== 'valid') { noImage++; continue; }

    // Period classification: dynasty field first, then dated string
    let bucket = periodFromString(obj.dynasty);
    if (bucket) { usedDynasty++; }
    else {
      bucket = periodFromDateString(obj.dated);
      if (bucket) { usedDated++; }
      else { noPeriod++; groups.other.push(obj); continue; }
    }

    groups[bucket].push({
      objectID:          String(obj.id),
      title:             obj.title || 'Untitled',
      objectDate:        obj.dated || obj.dynasty || '',
      medium:            obj.medium || '',
      objectURL:         `https://collections.artsmia.org/objects/${obj.id}`,
      primaryImageSmall: `${IMAGE_BASE}/${obj.id}/medium.jpg`,
      source:            'mia',
    });
  }

  console.log('Filtering:');
  console.log(`  From dynasty string:  ${usedDynasty}`);
  console.log(`  From dated string:    ${usedDated}`);
  console.log(`  No image:             ${noImage}`);
  console.log(`  No period (→ other):  ${noPeriod}`);

  console.log('\nDistribution:');
  let grand = 0;
  for (const p of [...PERIODS, { id: 'other' }]) {
    const n = groups[p.id]?.length ?? 0;
    if (n) { console.log(`  ${p.id.padEnd(14)} ${n}`); grand += n; }
  }
  console.log(`  ${'TOTAL'.padEnd(14)} ${grand}`);

  const out = `// Auto-generated by fetch-japanese-mia.js
// ${new Date().toISOString()} — ${grand} objects
// Minneapolis Institute of Art — Japanese Ceramics
// Open Access CC0: https://collections.artsmia.org/info/open-access
// To refresh: node fetch-japanese-mia.js
const JAPANESE_MIA_DATA = ${JSON.stringify(groups, null, 2)};
`;
  await writeFile(OUTPUT, out);
  console.log(`\nWrote ${OUTPUT} (${Math.round(Buffer.byteLength(out) / 1024)} KB)`);
}

main().catch(console.error);
