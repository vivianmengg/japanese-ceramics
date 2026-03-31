// fetch-japanese-rijks.js
// Fetches Japanese ceramics from the Rijksmuseum (Amsterdam) via OAI-PMH.
// Harvests the Japan collection set (26134) and filters for ceramics.
// No API key required — CC0 open access.
// Run: node fetch-japanese-rijks.js
// Writes: japanese-rijks-data.js

import { writeFile } from 'fs/promises';

const OAI_BASE = 'https://data.rijksmuseum.nl/oai';
const OUTPUT   = './japanese-rijks-data.js';

// Dutch material terms that indicate ceramics
const CERAMIC_FORMATS = new Set([
  'porselein', 'porseleinen', 'aardewerk', 'keramiek', 'steengoed',
  'faience', 'faïence', 'terracotta', 'biscuit', 'majolica',
  'raku', 'satsuma', 'imari',
]);

// Dutch object-type terms that indicate ceramics (as opposed to prints, textiles, etc.)
const CERAMIC_TYPES = new Set([
  'kom', 'schaal', 'schotel', 'bord', 'vaas', 'pot', 'kan', 'fles',
  'theepot', 'kop', 'stel', 'set', 'doos', 'deksel', 'schenkkan',
  'waterkan', 'melkkan', 'suikerpot', 'inktstel', 'inktpot',
  'wierookbrander', 'wierookvat', 'figuur', 'beeldje', 'standaard',
  'voetstuk', 'mandje', 'tegel',
]);

const PERIODS = [
  { id: 'jomon',      start: -10500, end:  -300 },
  { id: 'yayoi',      start:   -300, end:   300 },
  { id: 'nara-heian', start:    710, end:  1185 },
  { id: 'kamakura',   start:   1185, end:  1573 },
  { id: 'momoyama',   start:   1573, end:  1615 },
  { id: 'edo',        start:   1615, end:  1868 },
  { id: 'meiji',      start:   1868, end:  1912 },
];

// Parse Dutch date strings into a [startYear, endYear] pair
function parseDutchDate(s) {
  if (!s) return [null, null];
  const p = s.toLowerCase().trim();

  // Ordinal century map: "17de eeuw" → 1600-1700
  const ordMap = { '1ste':0,'2de':1,'3de':2,'4de':3,'5de':4,'6de':5,'7de':6,
    '8ste':7,'9de':8,'10de':9,'11de':10,'12de':11,'13de':12,'14de':13,
    '15de':14,'16de':15,'17de':16,'18de':17,'19de':18,'20ste':19,'21ste':20 };

  // "2de helft 17de eeuw" / "begin 17de eeuw" / "eind 17de eeuw"
  const halfM = p.match(/(\w+)\s+helft\s+(\w+)\s+eeuw/);
  if (halfM) {
    const c = ordMap[halfM[2]];
    if (c != null) {
      const base = c * 100;
      return halfM[1] === '1ste' ? [base, base + 50] : [base + 50, base + 100];
    }
  }
  const beginM = p.match(/begin\s+(\w+)\s+eeuw/);
  if (beginM) { const c = ordMap[beginM[1]]; if (c != null) return [c*100, c*100+33]; }
  const eindM  = p.match(/eind\s+(\w+)\s+eeuw/);
  if (eindM)  { const c = ordMap[eindM[1]];  if (c != null) return [c*100+67, c*100+100]; }
  const midden = p.match(/midden\s+(\w+)\s+eeuw/);
  if (midden)  { const c = ordMap[midden[1]]; if (c != null) return [c*100+33, c*100+67]; }

  // Plain century: "17de eeuw"
  const eeuwM = p.match(/(\w+)\s+eeuw/);
  if (eeuwM) { const c = ordMap[eeuwM[1]]; if (c != null) return [c*100, c*100+100]; }

  // Year range: "1615-1868" or "1615/1868"
  const rangeM = p.match(/(\d{3,4})\s*[-\/]\s*(\d{3,4})/);
  if (rangeM) return [parseInt(rangeM[1]), parseInt(rangeM[2])];

  // "voor YYYY" (before year) or "na YYYY" (after year)
  const voorM = p.match(/voor\s+(\d{3,4})/);
  if (voorM) { const y = parseInt(voorM[1]); return [y - 50, y]; }
  const naM = p.match(/na\s+(\d{3,4})/);
  if (naM)   { const y = parseInt(naM[1]);   return [y, y + 50]; }

  // "ca. YYYY"
  const caM = p.match(/ca\.?\s*(\d{3,4})/);
  if (caM) { const y = parseInt(caM[1]); return [y - 25, y + 25]; }

  // Plain year(s)
  const yearM = p.match(/(\d{3,4})/);
  if (yearM) { const y = parseInt(yearM[1]); return [y, y]; }

  return [null, null];
}

function periodFromYearRange(start, end) {
  if (start == null && end == null) return null;
  const s = start ?? end, e = end ?? start;
  let bestId = null, bestOverlap = 0;
  for (const p of PERIODS) {
    const overlap = Math.min(e, p.end) - Math.max(s, p.start);
    if (overlap > bestOverlap) { bestOverlap = overlap; bestId = p.id; }
  }
  return bestId;
}

function isCeramic(formats, types) {
  if (formats.some(f => CERAMIC_FORMATS.has(f.toLowerCase()))) return true;
  if (types.some(t => CERAMIC_TYPES.has(t.toLowerCase()))) return true;
  // Catch compound formats like "wit porselein", "blauw-wit porselein"
  if (formats.some(f => f.toLowerCase().includes('porselein') ||
    f.toLowerCase().includes('aardewerk') || f.toLowerCase().includes('keramiek') ||
    f.toLowerCase().includes('steengoed'))) return true;
  return false;
}

function thumbUrl(iiif) {
  if (!iiif) return null;
  // Replace /full/max/ with /full/600,/ for a reasonably-sized thumbnail
  return iiif.replace('/full/max/', '/full/600,/');
}

// Harvest all records from an OAI-PMH set via resumptionToken pagination
async function harvestSet(setSpec) {
  const all = [];
  let url = `${OAI_BASE}?verb=ListRecords&metadataPrefix=oai_dc&set=${setSpec}`;
  let page = 1;

  while (url) {
    process.stdout.write(`\r  Page ${page}... (${all.length} records)`);
    const text = await fetch(url).then(r => r.text());

    // Parse records
    for (const [, rec] of text.matchAll(/<record>([\s\S]*?)<\/record>/g)) {
      if (rec.includes('<header status="deleted">')) continue;
      const get    = (tag) => rec.match(new RegExp(`<dc:${tag}[^>]*>([\\s\\S]*?)<\\/dc:${tag}>`))?.[1]?.trim() ?? '';
      const getAll = (tag) => [...rec.matchAll(new RegExp(`<dc:${tag}[^>]*>([\\s\\S]*?)<\\/dc:${tag}>`, 'g'))].map(m => m[1].trim());
      all.push({
        id:      rec.match(/<identifier>(.*?)<\/identifier>/)?.[1] ?? '',
        title:   get('title'),
        date:    get('date'),
        formats: getAll('format'),
        types:   getAll('type'),
        objNum:  get('identifier'),
        image:   get('relation'),
        rights:  get('rights'),
      });
    }

    // Pagination
    const token = text.match(/<resumptionToken[^>]*>([^<]+)<\/resumptionToken>/)?.[1];
    url = token ? `${OAI_BASE}?verb=ListRecords&resumptionToken=${encodeURIComponent(token)}` : null;
    page++;
    if (url) await new Promise(r => setTimeout(r, 200));
  }
  console.log(`\r  Done — ${all.length} records harvested`);
  return all;
}

async function main() {
  console.log('Fetching Rijksmuseum — Japanese Ceramics (Japan collection, set 26134)\n');

  const raw = await harvestSet('26134');
  console.log(`\n  Total Japan collection records: ${raw.length}`);

  // Filter for ceramics with images and CC0 rights
  const ceramics = raw.filter(r =>
    isCeramic(r.formats, r.types) &&
    r.image &&
    r.rights?.includes('creativecommons.org/publicdomain')
  );
  console.log(`  Ceramic objects with CC0 images: ${ceramics.length}\n`);

  const groups = {};
  for (const p of PERIODS) groups[p.id] = [];
  groups.other = [];

  let classified = 0, noPeriod = 0;

  for (const item of ceramics) {
    const [start, end] = parseDutchDate(item.date);
    const bucket = periodFromYearRange(start, end);

    if (bucket) { classified++; }
    else { noPeriod++; continue; }

    // Object URL: https://www.rijksmuseum.nl/en/collection/{objectNumber}
    const objUrl = item.objNum
      ? `https://www.rijksmuseum.nl/en/collection/${item.objNum}`
      : item.id.replace('https://id.rijksmuseum.nl/', 'https://www.rijksmuseum.nl/en/collection/');

    groups[bucket].push({
      objectID:          item.id.split('/').pop(),
      title:             item.title || 'Untitled',
      objectDate:        item.date,
      medium:            item.formats.join(', '),
      objectURL:         objUrl,
      primaryImageSmall: thumbUrl(item.image),
      source:            'rijks',
    });
  }

  console.log('Classification:');
  console.log(`  Classified:  ${classified}`);
  console.log(`  No period:   ${noPeriod}`);

  console.log('\nDistribution:');
  let grand = 0;
  for (const p of [...PERIODS, { id: 'other' }]) {
    const n = groups[p.id]?.length ?? 0;
    if (n) { console.log(`  ${p.id.padEnd(14)} ${n}`); grand += n; }
  }
  console.log(`  ${'TOTAL'.padEnd(14)} ${grand}`);

  const out = `// Auto-generated by fetch-japanese-rijks.js
// ${new Date().toISOString()} — ${grand} objects
// Rijksmuseum (Amsterdam) — Japanese Ceramics, Japan collection
// Open Access CC0: https://www.rijksmuseum.nl/en/research/conduct-research/data
// To refresh: node fetch-japanese-rijks.js
const JAPANESE_RIJKS_DATA = ${JSON.stringify(groups, null, 2)};
`;
  await writeFile(OUTPUT, out);
  console.log(`\nWrote ${OUTPUT} (${Math.round(Buffer.byteLength(out) / 1024)} KB)`);
}

main().catch(console.error);
