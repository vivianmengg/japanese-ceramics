// fetch-japanese-harvard.js
// Fetches Japanese pottery from the Harvard Art Museums API, classifies by period.
// Run: node fetch-japanese-harvard.js
// Writes: japanese-harvard-data.js

import { writeFile } from 'fs/promises';

const API_KEY   = '01a8df91-8bbe-430d-8cf4-191d3fd90e3f';
const BASE      = 'https://api.harvardartmuseums.org';
const OUTPUT    = './japanese-harvard-data.js';
const PAGE_SIZE = 100;

const FIELDS = 'id,title,dated,datebegin,dateend,period,culture,medium,classification,primaryimageurl,url,imagepermissionlevel,images';

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

function periodFromDates(begin, end) {
  if (begin === 0 && end === 0) return null;
  if (begin == null && end == null) return null;
  const s = begin ?? end, e = end ?? begin;
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

const CLASSIFICATIONS = ['Vessels', 'Ceramics', 'Pottery', 'Sculpture', 'Fragments'];

async function fetchClassification(classification) {
  const url = (page) =>
    `${BASE}/object?apikey=${API_KEY}&classification=${encodeURIComponent(classification)}&culture=Japanese&hasimage=1&size=${PAGE_SIZE}&page=${page}&fields=${FIELDS}`;
  const first = await (await fetch(url(1))).json();
  const totalPages = first.info?.pages ?? 1;
  process.stdout.write(`  ${classification}: ${first.info?.totalrecords ?? 0} objects...`);
  const records = [...(first.records || [])];
  for (let p = 2; p <= totalPages; p++) {
    const data = await (await fetch(url(p))).json();
    records.push(...(data.records || []));
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(` done`);
  return records;
}

async function main() {
  console.log('Fetching Harvard Art Museums — Japanese Ceramics\n');

  const seen = new Set();
  const raw = [];
  for (const cls of CLASSIFICATIONS) {
    const records = await fetchClassification(cls);
    for (const r of records) {
      if (!seen.has(r.id)) { seen.add(r.id); raw.push(r); }
    }
  }
  console.log(`\nTotal unique records: ${raw.length}\n`);

  const groups = {};
  for (const p of PERIODS) groups[p.id] = [];
  groups.other = [];

  let usedPeriod = 0, usedDates = 0, skipped = 0;

  for (const o of raw) {
    if (!o.primaryimageurl) { skipped++; continue; }
    if (o.imagepermissionlevel > 0) { skipped++; continue; }
    if (!o.medium || !/porcelain|stoneware|earthenware|ceramic|terracotta|terra.cotta|bisque|faience|tin.glaze|slip.ware|celadon|fritware|lead.glaze/i.test(o.medium)) { skipped++; continue; }

    let bucket = periodFromString(o.period);
    if (bucket) { usedPeriod++; }
    else {
      bucket = periodFromDates(o.datebegin, o.dateend);
      if (bucket) usedDates++;
      else { groups.other.push(o); skipped++; continue; }
    }

    groups[bucket].push({
      objectID:          o.id,
      title:             o.title || 'Untitled',
      culture:           o.culture || 'Japan',
      objectDate:        o.dated  || '',
      objectBeginDate:   o.datebegin ?? null,
      objectEndDate:     o.dateend   ?? null,
      period:            o.period || '',
      medium:            o.medium || '',
      objectURL:         o.url || `https://www.harvardartmuseums.org/collections/object/${o.id}`,
      primaryImageSmall: o.images?.[0]?.iiifbaseuri
        ? `${o.images[0].iiifbaseuri}/full/!300,300/0/default.jpg`
        : o.primaryimageurl,
      source: 'harvard',
    });
  }

  for (const objs of Object.values(groups)) {
    objs.sort((a, b) => (a.objectBeginDate ?? 9999) - (b.objectBeginDate ?? 9999));
  }

  console.log('Classification method:');
  console.log(`  From period string: ${usedPeriod}`);
  console.log(`  From date fallback: ${usedDates}`);
  console.log(`  Skipped:            ${skipped}`);

  console.log('\nDistribution:');
  let grand = 0;
  for (const p of [...PERIODS, { id: 'other' }]) {
    const n = groups[p.id]?.length ?? 0;
    if (n) { console.log(`  ${p.id.padEnd(14)} ${n}`); grand += n; }
  }
  console.log(`  ${'TOTAL'.padEnd(14)} ${grand}`);

  const out = `// Auto-generated by fetch-japanese-harvard.js
// ${new Date().toISOString()} — ${grand} objects
// Harvard Art Museums Open Access — Japanese Ceramics
// To refresh: node fetch-japanese-harvard.js
const JAPANESE_HARVARD_DATA = ${JSON.stringify(groups, null, 2)};
`;
  await writeFile(OUTPUT, out);
  console.log(`\nWrote ${OUTPUT} (${Math.round(Buffer.byteLength(out) / 1024)} KB)`);
}

main().catch(console.error);
