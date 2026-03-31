// fetch-japanese-freer.js
// Fetches Japanese ceramics from the Smithsonian National Museum of Asian Art
// (Freer Gallery of Art + Arthur M. Sackler Gallery), unit code FSG.
//
// API key required — free & instant: https://api.data.gov/signup/
// Run: SI_API_KEY=your_key node fetch-japanese-freer.js
// Writes: japanese-freer-data.js
//
// Smithsonian Open Access (CC0): https://www.si.edu/openaccess

import { writeFile } from 'fs/promises';

const API_KEY = process.env.SI_API_KEY;
if (!API_KEY) {
  console.error('Error: SI_API_KEY not set. Get one at https://api.data.gov/signup/');
  process.exit(1);
}

const BASE    = 'https://api.si.edu/openaccess/api/v1.0';
const OUTPUT  = './japanese-freer-data.js';
const ROW_MAX = 100;

// The Freer/Sackler merged into the National Museum of Asian Art in 2019 — unit code is now NMAA
const QUERY = 'unit_code:NMAA AND (ceramic OR porcelain OR stoneware OR earthenware OR pottery)';

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

function periodFromDates(dates) {
  // dates is an array of strings like "1300s", "1615-1868", "200s BCE"
  if (!dates?.length) return null;
  for (const d of dates) {
    const bce = /bce/i.test(d);
    const rangeM = d.match(/^(\d{3,5})-(\d{3,5})$/);
    if (rangeM) {
      const year = (parseInt(rangeM[1]) + parseInt(rangeM[2])) / 2;
      const res = periodFromYear(bce ? -year : year);
      if (res) return res;
      continue;
    }
    const decadeM = d.match(/^(\d{3,5})s$/);
    if (decadeM) {
      const year = parseInt(decadeM[1]);
      const res = periodFromYear(bce ? -year : year);
      if (res) return res;
      continue;
    }
    const plainM = d.match(/^(\d{3,5})$/);
    if (plainM) {
      const year = parseInt(plainM[1]);
      const res = periodFromYear(bce ? -year : year);
      if (res) return res;
    }
  }
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

function isJapaneseObject(row) {
  const is = row.content?.indexedStructured || {};
  const ft = row.content?.freetext || {};

  const places  = (is.place || []).map(p => p.toLowerCase());
  const topics  = (is.topic || []).map(t => t.toLowerCase());
  const ftPlace = (ft.place || []).map(p => (p.content || '').toLowerCase());
  const ftDate  = (ft.date  || []).map(p => (p.content || '').toLowerCase());

  const japanPlace = places.some(p => p.includes('japan') || p.includes('japanese'))
    || ftPlace.some(p => p.includes('japan'))
    || topics.some(t => t.includes('japanese'));

  const japanPeriod = ftDate.some(d =>
    /\b(edo|meiji|kamakura|muromachi|momoyama|heian|nara|jōmon|jomon|yayoi|tokugawa|taisho|showa)\b/.test(d)
  );

  const notJapan = places.some(p =>
    p.includes('china') || p.includes('korea') || p.includes('vietnam') ||
    p.includes('india') || p.includes('persia') || p.includes('iran')
  ) && !japanPlace;

  return (japanPlace || japanPeriod) && !notJapan;
}

function extractThumb(dnr) {
  const media = dnr?.online_media?.media;
  if (!media?.length) return null;
  for (const m of media) {
    if (m.type !== 'Images') continue;
    const screen = m.resources?.find(r => r.label === 'Screen Image');
    if (screen?.url) return screen.url;
    if (m.content) return m.content + '&max_w=600';
    if (m.thumbnail) return m.thumbnail + '&max_w=600';
  }
  return null;
}

function freePick(arr, ...labels) {
  if (!arr?.length) return '';
  const lower = labels.map(l => l.toLowerCase());
  for (const { label, content } of arr) {
    if (content && lower.includes(label?.toLowerCase())) return content;
  }
  return '';
}

async function fetchPageRaw(start) {
  const qs = [
    `q=${encodeURIComponent(QUERY)}`,
    `rows=${ROW_MAX}`,
    `start=${start}`,
    `api_key=${API_KEY}`,
  ].join('&');
  const res = await fetch(`${BASE}/search?${qs}`);
  if (res.status === 429) {
    console.log('\n  Rate limited — waiting 60s...');
    await new Promise(r => setTimeout(r, 60000));
    return fetchPageRaw(start);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} at start=${start}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data;
}

async function main() {
  console.log('Fetching Freer/Sackler Gallery — Japanese Ceramics\n');

  const first = await fetchPageRaw(0);
  const total = first.response?.rowCount ?? 0;
  const pages = Math.ceil(total / ROW_MAX);
  console.log(`Total FSG ceramic objects with images: ${total} (${pages} pages)\n`);

  const rows = [...(first.response?.rows ?? [])];
  for (let p = 1; p < pages; p++) {
    process.stdout.write(`\r  Fetching page ${p + 1}/${pages}...`);
    const data = await fetchPageRaw(p * ROW_MAX);
    rows.push(...(data.response?.rows ?? []));
    await new Promise(r => setTimeout(r, 250));
  }
  if (pages > 1) console.log();
  console.log(`  ${rows.length} raw records\n`);

  const groups = {};
  for (const p of PERIODS) groups[p.id] = [];
  groups.other = [];

  let usedFreetext = 0, usedIndexed = 0, notJapanese = 0, noImage = 0, noPeriod = 0;

  for (const row of rows) {
    const dnr = row.content?.descriptiveNonRepeating;
    const ft  = row.content?.freetext;
    const is  = row.content?.indexedStructured;

    const thumb = extractThumb(dnr);
    if (!thumb) { noImage++; continue; }

    if (!isJapaneseObject(row)) { notJapanese++; continue; }

    // Classify period — freetext date first, then indexed dates
    const ftDates = (ft?.date || []).map(d => d.content || '');
    let bucket = null;
    for (const d of ftDates) {
      bucket = periodFromString(d);
      if (bucket) break;
    }
    if (bucket) { usedFreetext++; }
    else {
      bucket = periodFromDates(is?.date || []);
      if (bucket) { usedIndexed++; }
      else { noPeriod++; groups.other.push(row); continue; }
    }

    const recId   = dnr?.record_ID || row.id;
    const dateStr = freePick(ft?.date || [], 'Date', 'date', 'Period', 'period');
    const medium  = freePick(ft?.physicalDescription || [], 'Medium', 'Material', 'medium', 'Physical description');

    groups[bucket].push({
      objectID:          recId,
      title:             row.title || 'Untitled',
      objectDate:        dateStr,
      medium:            medium,
      objectURL:         dnr?.record_link || `https://asia.si.edu/object/${recId}/`,
      primaryImageSmall: thumb,
      source:            'freer',
    });
  }

  console.log('Filtering:');
  console.log(`  Japanese objects kept:  ${usedFreetext + usedIndexed}`);
  console.log(`  Not Japanese:           ${notJapanese}`);
  console.log(`  No image:               ${noImage}`);
  console.log(`  No period (→ other):    ${noPeriod}`);
  console.log(`  From freetext date:     ${usedFreetext}`);
  console.log(`  From indexed date:      ${usedIndexed}`);

  console.log('\nDistribution:');
  let grand = 0;
  for (const p of [...PERIODS, { id: 'other' }]) {
    const n = groups[p.id]?.length ?? 0;
    if (n) { console.log(`  ${p.id.padEnd(14)} ${n}`); grand += n; }
  }
  console.log(`  ${'TOTAL'.padEnd(14)} ${grand}`);

  const out = `// Auto-generated by fetch-japanese-freer.js
// ${new Date().toISOString()} — ${grand} objects
// Smithsonian National Museum of Asian Art (Freer/Sackler Gallery) — Japanese Ceramics
// Open Access CC0: https://www.si.edu/openaccess
// To refresh: SI_API_KEY=your_key node fetch-japanese-freer.js
const JAPANESE_FREER_DATA = ${JSON.stringify(groups, null, 2)};
`;
  await writeFile(OUTPUT, out);
  console.log(`\nWrote ${OUTPUT} (${Math.round(Buffer.byteLength(out) / 1024)} KB)`);
}

main().catch(console.error);
