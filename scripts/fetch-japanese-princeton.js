// fetch-japanese-princeton.js
// Fetches Japanese pottery from the Princeton University Art Museum API.
// No API key needed. Free open access.
// Run: node fetch-japanese-princeton.js
// Writes: japanese-princeton-data.js

import { writeFile } from 'fs/promises';

const BASE   = 'https://data.artmuseum.princeton.edu';
const OUTPUT = './japanese-princeton-data.js';

const PERIODS = [
  { id: 'jomon',      label: 'Jōmon',              start: -10500, end:  -300 },
  { id: 'yayoi',      label: 'Yayoi',               start:   -300, end:   300 },
  { id: 'nara-heian', label: 'Nara & Heian',         start:    710, end:  1185 },
  { id: 'kamakura',   label: 'Kamakura & Muromachi', start:   1185, end:  1573 },
  { id: 'momoyama',   label: 'Momoyama',             start:   1573, end:  1615 },
  { id: 'edo',        label: 'Edo',                  start:   1615, end:  1868 },
  { id: 'meiji',      label: 'Meiji',                start:   1868, end:  1912 },
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

function periodFromDates(begin, end) {
  if (begin == null || end == null) return null;
  if (begin === 0 && end > 500) return null;
  const s = begin, e = end;
  let bestId = null, bestOverlap = 0;
  for (const p of PERIODS) {
    const overlap = Math.min(e, p.end) - Math.max(s, p.start);
    if (overlap > bestOverlap) { bestOverlap = overlap; bestId = p.id; }
  }
  if (bestId) return bestId;
  const mid = (s + e) / 2;
  let nearest = PERIODS[0], minDist = Infinity;
  for (const p of PERIODS) {
    const dist = Math.abs(mid - (p.start + p.end) / 2);
    if (dist < minDist) { minDist = dist; nearest = p; }
  }
  return nearest.id;
}

function periodFromPeriods(periods) {
  if (!periods?.length) return null;
  for (const p of periods) {
    const name = (p.period || p.displayperiod || '').toLowerCase();
    const bucket = periodFromString(name);
    if (bucket) return bucket;
    const d = periodFromDates(p.begindate, p.enddate);
    if (d) return d;
  }
  return null;
}

const QUERIES = [
  'japan ceramic',
  'japan porcelain',
  'japan stoneware',
  'japan earthenware',
  'edo period ceramic',
  'edo period porcelain',
  'meiji period ceramic',
  'kamakura period ceramic',
  'imari porcelain',
  'kakiemon',
  'nabeshima',
  'satsuma',
  'bizen stoneware',
  'shigaraki',
  'raku ware',
  'jomon',
  'arita porcelain',
  'kutani',
  'kenzan',
  'oribe',
];

async function search(q, from = 0) {
  const url = `${BASE}/search?q=${encodeURIComponent(q)}&size=500&from=${from}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for "${q}"`);
  return (await res.json()).hits;
}

async function fetchObject(id) {
  const res = await fetch(`${BASE}/objects/${id}`);
  if (!res.ok) return null;
  return res.json();
}

function isJapaneseObject(obj) {
  if (!obj) return false;
  if (obj.geography?.some(g =>
    g.country?.toLowerCase().includes('japan') ||
    g.nationality?.toLowerCase().includes('japanese')
  )) return true;
  if (obj.displayculture?.toLowerCase().includes('japan')) return true;
  if (obj.cultures?.some(c => c.displayculture?.toLowerCase().includes('japan'))) return true;
  const period = (obj.displayperiod || '').toLowerCase();
  if (['edo', 'meiji', 'kamakura', 'muromachi', 'momoyama', 'heian', 'nara', 'jomon', 'yayoi', 'tokugawa'].some(p => period.includes(p))) return true;
  return false;
}

function extractThumb(obj) {
  const base = obj.primaryimage?.[0] || obj.media?.find(m => m.isprimary)?.uri;
  if (!base) return null;
  if (!base.includes('media.artmuseum.princeton.edu')) return null;
  return `${base}/full/400,/0/default.jpg`;
}

function extractTitle(obj) {
  return obj.titles?.find(t => t.titletype === 'Primary Title')?.title
      || obj.displaytitle
      || 'Untitled';
}

async function main() {
  console.log('Fetching Princeton University Art Museum — Japanese Ceramics\n');

  const allIds = new Set();
  for (const q of QUERIES) {
    process.stdout.write(`  "${q}"...`);
    try {
      const hits = await search(q);
      let added = 0;
      for (const h of hits.hits) {
        if (!allIds.has(h._source.objectid)) { allIds.add(h._source.objectid); added++; }
      }
      console.log(` ${hits.total} hits, ${added} new (${allIds.size} total)`);
      if (hits.total > 500) {
        const pages = Math.min(Math.ceil(hits.total / 500), 4);
        for (let p = 1; p < pages; p++) {
          const more = await search(q, p * 500);
          more.hits.forEach(h => allIds.add(h._source.objectid));
          await new Promise(r => setTimeout(r, 200));
        }
      }
    } catch(e) {
      console.log(` ERROR: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nUnique IDs to fetch: ${allIds.size}`);

  const ids = [...allIds];
  const raw = [];
  for (let i = 0; i < ids.length; i++) {
    if (i % 50 === 0) process.stdout.write(`\r  ${i}/${ids.length}...`);
    const obj = await fetchObject(ids[i]).catch(() => null);
    if (obj) raw.push(obj);
    await new Promise(r => setTimeout(r, 150));
  }
  process.stdout.write(`\r  ${raw.length} objects fetched\n`);

  const groups = {};
  for (const p of PERIODS) groups[p.id] = [];
  let skippedJapanese = 0, skippedPeriod = 0, skippedImage = 0, kept = 0;

  for (const o of raw) {
    if (o.nowebuse === 'True' || o.restrictions) { skippedImage++; continue; }
    const thumb = extractThumb(o);
    if (!thumb) { skippedImage++; continue; }
    if (!isJapaneseObject(o)) { skippedJapanese++; continue; }
    if (!o.medium || !/porcelain|stoneware|earthenware|ceramic|terracotta|terra.cotta|bisque|faience|tin.glaze|celadon|slip.ware|lead.glaze/i.test(o.medium)) { skippedJapanese++; continue; }

    const period = periodFromPeriods(o.periods) || periodFromDates(o.datebegin, o.dateend);
    if (!period) { skippedPeriod++; continue; }

    groups[period].push({
      objectID:        o.objectid,
      title:           extractTitle(o),
      culture:         o.displayculture || 'Japan',
      objectDate:      o.displaydate || o.daterange || '',
      objectBeginDate: o.datebegin ?? null,
      objectEndDate:   o.dateend   ?? null,
      medium:          o.medium    || '',
      objectURL:       `https://artmuseum.princeton.edu/collections/objects/${o.objectid}`,
      primaryImageSmall: thumb,
      source:          'princeton',
    });
    kept++;
  }

  console.log(`\nFiltering:`);
  console.log(`  Kept:           ${kept}`);
  console.log(`  Not Japanese:   ${skippedJapanese}`);
  console.log(`  No period:      ${skippedPeriod}`);
  console.log(`  No image:       ${skippedImage}`);
  console.log('\nBy period:');
  PERIODS.forEach(p => console.log(`  ${p.label.padEnd(22)} ${groups[p.id].length}`));

  const out = `// Auto-generated by fetch-japanese-princeton.js
// ${new Date().toISOString()} — ${kept} objects
// Princeton University Art Museum Open Access — Japanese Ceramics
// To refresh: node fetch-japanese-princeton.js
const JAPANESE_PRINCETON_DATA = ${JSON.stringify(groups)};
`;
  await writeFile(OUTPUT, out);
  console.log(`\nWrote ${OUTPUT} (${Math.round(Buffer.byteLength(out) / 1024)} KB)`);
}

main().catch(console.error);
