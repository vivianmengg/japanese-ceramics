// fetch-japanese-colbase.js
// Fetches Japanese ceramics from ColBase (Japanese National Museums) via the Japan Search API.
// ColBase covers: Tokyo, Kyoto, Nara, and Kyushu National Museums.
// API docs: https://jpsearch.go.jp/static/developer/en.html
// Run: node fetch-japanese-colbase.js
// Writes: japanese-colbase-data.js

import { writeFile } from 'fs/promises';

const SCROLL_BASE = 'https://jpsearch.go.jp/api/item/scroll/cobas-default';
const OUTPUT      = './japanese-colbase-data.js';
const SCROLL_SIZE = 200;

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

  // Japanese-script period names (ColBase primary format)
  if (p.includes('縄文'))                                                    return 'jomon';
  if (p.includes('弥生'))                                                    return 'yayoi';
  if (p.includes('古墳') || p.includes('飛鳥'))                             return 'nara-heian';
  if (p.includes('奈良') || p.includes('平安'))                             return 'nara-heian';
  if (p.includes('鎌倉') || p.includes('室町') || p.includes('南北朝') ||
      p.includes('足利'))                                                     return 'kamakura';
  if (p.includes('桃山') || p.includes('安土'))                             return 'momoyama';
  if (p.includes('江戸') || p.includes('徳川'))                             return 'edo';
  if (p.includes('明治') || p.includes('大正') || p.includes('昭和') ||
      p.includes('近代') || p.includes('現代'))                             return 'meiji';

  // Romanised / English period names
  if (p.includes('jōmon') || p.includes('jomon'))                           return 'jomon';
  if (p.includes('yayoi'))                                                   return 'yayoi';
  if (p.includes('kofun') || p.includes('asuka'))                           return 'nara-heian';
  if (p.includes('nara') || p.includes('heian'))                            return 'nara-heian';
  if (p.includes('kamakura') || p.includes('muromachi') || p.includes('nanboku') ||
      p.includes('namboku') || p.includes('ashikaga'))                       return 'kamakura';
  if (p.includes('momoyama') || p.includes('azuchi'))                       return 'momoyama';
  if (p.includes('edo') || p.includes('tokugawa'))                          return 'edo';
  if (p.includes('meiji') || p.includes('taisho') || p.includes('taishō') ||
      p.includes('showa') || p.includes('shōwa') || p.includes('modern'))   return 'meiji';

  // Broad era labels
  if (p.includes('古代'))                                                    return 'nara-heian';
  if (p.includes('中世'))                                                    return 'kamakura';
  if (p.includes('近世'))                                                    return 'edo';
  return null;
}

// Parse century string to approximate year range, e.g. "12th–13th century" → [1100, 1300]
function yearsFromPeriodString(period) {
  if (!period) return [null, null];
  const m = period.match(/(\d+)(?:st|nd|rd|th)(?:[–\-](\d+)(?:st|nd|rd|th))?\s*century/i);
  if (!m) return [null, null];
  const start = (parseInt(m[1]) - 1) * 100;
  const end   = m[2] ? parseInt(m[2]) * 100 : start + 100;
  if (period.toLowerCase().includes('b.c') || period.toLowerCase().includes('bce')) {
    return [-end, -start];
  }
  return [start, end];
}

function periodFromDates(begin, end) {
  if (begin == null && end == null) return null;
  const s = begin ?? end, e = end ?? begin;
  let bestId = null, bestOverlap = 0;
  for (const p of PERIODS) {
    const overlap = Math.min(e, p.end) - Math.max(s, p.start);
    if (overlap > bestOverlap) { bestOverlap = overlap; bestId = p.id; }
  }
  return bestId;
}

function isJapaneseCeramic(item) {
  const genre   = (item['cobas-31-s'] || '').toLowerCase();
  const origin  = (item['cobas-9-s']  || '').toLowerCase();
  const period  = (item['cobas-37-s'] || '').toLowerCase();
  const medium  = (item['cobas-38-s'] || '').toLowerCase();
  const titleEn = (item['cobas-32-s'] || item.common?.titleEn || '').toLowerCase();
  const titleJp = (item['cobas-5-s']  || '').toLowerCase();

  // ── Step 1: Exclude explicitly non-ceramic materials ───────────────────────
  if (medium && (
    medium.includes('bronze') || medium.includes('iron') || medium.includes('copper') ||
    medium.includes('gold') || medium.includes('silver') || medium.includes('brass') ||
    medium.includes('steel') || medium.includes('metal') ||
    medium.includes('stone') || medium.includes('jade') || medium.includes('jasper') ||
    medium.includes('antler') || medium.includes('bone') || medium.includes('horn') ||
    medium.includes('bamboo') || medium.includes('wood') || medium.includes('lacquer') ||
    medium.includes('silk') || medium.includes('textile') || medium.includes('fabric') ||
    medium.includes('paper') || medium.includes('ink') || medium.includes('pigment') ||
    medium.includes('glass') || medium.includes('crystal') || medium.includes('shell')
  )) return false;

  // ── Step 2: Exclude explicitly non-ceramic genres ──────────────────────────
  if (genre && (
    genre.includes('book') || genre.includes('lacquer') || genre.includes('漆工') ||
    genre.includes('textile') || genre.includes('染織') ||
    genre.includes('painting') || genre.includes('絵画') ||
    genre.includes('print') || genre.includes('版画') ||
    genre.includes('drawing') || genre.includes('書跡') ||
    genre.includes('sword') || genre.includes('armor') || genre.includes('armour') ||
    genre.includes('bronze') || genre.includes('metalwork') || genre.includes('金工')
  )) return false;

  // ── Step 3: Require positive ceramic evidence ──────────────────────────────
  // At least one of: ceramic medium term, ceramic genre, or ceramic-suggesting title
  const hasCeramicMedium =
    medium.includes('earthenware') || medium.includes('stoneware') ||
    medium.includes('porcelain') || medium.includes('ceramic') ||
    medium.includes('pottery') || medium.includes('clay') ||
    medium.includes('terra') || medium.includes('glaze') ||
    medium.includes('sue') || medium.includes('haji') || medium.includes('ware');

  const hasCeramicGenre =
    genre.includes('ceramic') || genre.includes('陶') || genre.includes('pottery');

  const hasCeramicTitle =
    titleEn.includes('vessel') || titleEn.includes('jar') ||
    titleEn.includes('bowl') || titleEn.includes('vase') ||
    titleEn.includes('pot') || titleEn.includes('cup') ||
    titleEn.includes('bottle') || titleEn.includes('dish') ||
    titleEn.includes('plate') || titleEn.includes('ewer') ||
    titleEn.includes('flask') || titleEn.includes('censer') ||
    titleEn.includes('teabowl') || titleEn.includes('tea bowl') ||
    titleEn.includes('stoneware') || titleEn.includes('earthenware') ||
    titleEn.includes('porcelain') || titleEn.includes('ceramic') ||
    titleEn.includes('pottery') || titleEn.includes('shard') ||
    titleEn.includes('sherd') || titleEn.includes('jomon') ||
    titleEn.includes('yayoi') || titleEn.includes('sue') ||
    titleJp.includes('土器') || titleJp.includes('陶') || titleJp.includes('磁') ||
    titleJp.includes('碗') || titleJp.includes('壺') || titleJp.includes('皿') ||
    titleJp.includes('瓶') || titleJp.includes('鉢') || titleJp.includes('徳利') ||
    titleJp.includes('茶碗') || titleJp.includes('水指') || titleJp.includes('花入');

  if (!hasCeramicMedium && !hasCeramicGenre && !hasCeramicTitle) return false;

  // ── Step 4: Exclude non-Japanese origins ───────────────────────────────────
  if (origin && (
    origin.includes('中国') || origin.includes('china') ||
    origin.includes('朝鮮') || origin.includes('韓国') || origin.includes('korea') ||
    origin.includes('フランス') || origin.includes('france') ||
    origin.includes('イラン') || origin.includes('iran') ||
    origin.includes('エジプト') || origin.includes('egypt') ||
    origin.includes('ベトナム') || origin.includes('vietnam') ||
    origin.includes('クメール') || origin.includes('khmer') ||
    origin.includes('シリア') || origin.includes('syria') ||
    origin.includes('ドイツ') || origin.includes('germany') ||
    origin.includes('イギリス') || origin.includes('england') ||
    origin.includes('オランダ') || origin.includes('netherlands')
  )) return false;

  // ── Step 5: Exclude non-Japanese period dynasties ──────────────────────────
  if (period && (
    period.includes('tang dynasty') || period.includes('song dynasty') ||
    period.includes('ming dynasty') || period.includes('qing dynasty') ||
    period.includes('yuan dynasty') || period.includes('han dynasty') ||
    period.includes('goryeo') || period.includes('joseon') ||
    period.includes('高麗') || period.includes('朝鮮王') ||
    period.includes('angkor') || period.includes('アンコール')
  )) return false;

  return true;
}

async function fetchAllScroll(keyword) {
  const url = `${SCROLL_BASE}?keyword=${encodeURIComponent(keyword)}&size=${SCROLL_SIZE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const first = await res.json();
  const total = first.hit;
  const all = [...(first.list || [])];
  let scrollId = first.scrollId;

  process.stdout.write(`  "${keyword}" → ${total} hits`);
  while (scrollId && all.length < total) {
    process.stdout.write(`\r  "${keyword}" → ${all.length}/${total}...`);
    const r = await fetch(`${SCROLL_BASE}?scrollId=${encodeURIComponent(scrollId)}&size=${SCROLL_SIZE}`);
    if (!r.ok) break;
    const d = await r.json();
    if (!d.list?.length) break;
    all.push(...d.list);
    scrollId = d.scrollId;
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`\r  "${keyword}" → ${all.length} fetched (${total} total)           `);
  return all;
}

async function main() {
  console.log('Fetching ColBase (Japanese National Museums) — Japanese Ceramics...\n');

  const keywords = [
    // Prehistoric / ancient wares — most important for early periods
    '縄文土器',     // Jōmon earthenware
    '縄文',         // Jōmon period broadly
    '弥生土器',     // Yayoi earthenware
    '弥生',         // Yayoi period broadly
    '須恵器',       // Sue ware — grey stoneware from Kofun through Nara
    '土師器',       // Haji ware — earthenware from Kofun through Heian

    // Broad ceramic terms
    '陶磁',         // ceramics broadly
    '陶磁器',       // ceramics (combined form)
    '陶器',         // pottery / earthenware
    '磁器',         // porcelain
    '土器',         // earthenware

    // Glaze / decoration techniques — largely Japanese-specific
    '色絵',         // iro-e overglaze enamel
    '染付',         // sometsuke blue-and-white (also Chinese, but filtered)
    '白磁',         // hakuji white porcelain
    '青磁',         // seiji celadon (also Chinese/Korean, but filtered)
    '天目',         // tenmoku iron-glazed wares
    '茶陶',         // chatō — tea ceremony ceramics

    // Vessel forms with strong ceramic association
    '茶碗',         // chawan — tea bowl

    // The six ancient kilns (六古窯) + major later kilns
    '備前焼',       // Bizen ware
    '信楽焼',       // Shigaraki ware
    '常滑焼',       // Tokoname ware
    '越前焼',       // Echizen ware
    '丹波焼',       // Tamba ware
    '瀬戸焼',       // Seto ware
    '美濃焼',       // Mino ware (Shino, Oribe, Ki-Seto)
    '志野焼',       // Shino ware
    '織部焼',       // Oribe ware
    '楽焼',         // Raku ware
    '萩焼',         // Hagi ware
    '唐津焼',       // Karatsu ware
    '有田焼',       // Arita ware
    '伊万里焼',     // Imari ware
    '鍋島焼',       // Nabeshima ware
    '薩摩焼',       // Satsuma ware
    '九谷焼',       // Kutani ware
    '清水焼',       // Kiyomizu / Kyoto ware
  ];

  const raw = [];
  const seen = new Set();
  for (const keyword of keywords) {
    const items = await fetchAllScroll(keyword);
    for (const item of items) {
      const id = item['cobas-0-s'] || item.common?.id;
      if (id && !seen.has(id)) { seen.add(id); raw.push(item); }
    }
  }
  console.log(`\n  Total unique records fetched: ${raw.length}`);

  const kept = raw.filter(isJapaneseCeramic);
  console.log(`  After exclusion filter:       ${kept.length}`);

  const groups = {};
  for (const p of PERIODS) groups[p.id] = [];
  groups.other = [];

  let usedPeriod = 0, usedDates = 0, noImage = 0, noPeriod = 0;

  for (const item of kept) {
    const imageUrl = item.common?.thumbnailUrl?.[0] || item['cobas-18-u'];
    if (!imageUrl) { noImage++; continue; }

    const itemId    = item['cobas-0-s'] || item.common?.id;
    const periodStr = item['cobas-37-s'] || item.common?.temporal?.[0] || '';

    let bucket = periodFromString(periodStr);
    if (bucket) { usedPeriod++; }
    else {
      const [begin, end] = yearsFromPeriodString(periodStr);
      bucket = periodFromDates(begin, end);
      if (bucket) { usedDates++; }
      else { noPeriod++; groups.other.push(null); continue; } // track count only
    }

    const titleEn   = item['cobas-32-s'] || item.common?.titleEn || item['cobas-5-s'] || 'Untitled';
    const museum    = item['cobas-42-s'] || item.common?.provider || 'Japanese National Museum';
    const detailUrl = item['cobas-1-u']  || item.common?.linkUrl  || '';

    groups[bucket].push({
      objectID:          itemId,
      title:             titleEn,
      objectDate:        periodStr,
      medium:            item['cobas-38-s'] || '',
      museum:            museum,
      objectURL:         detailUrl,
      primaryImageSmall: imageUrl,
      source:            'colbase',
    });
  }

  console.log('\nClassification:');
  console.log(`  Period string:  ${usedPeriod}`);
  console.log(`  Date fallback:  ${usedDates}`);
  console.log(`  No image:       ${noImage}`);
  console.log(`  No period:      ${noPeriod}`);

  console.log('\nDistribution:');
  let grand = 0;
  for (const p of [...PERIODS, { id: 'other' }]) {
    const n = (p.id === 'other' ? noPeriod : groups[p.id]?.length) ?? 0;
    if (n) { console.log(`  ${p.id.padEnd(14)} ${n}`); grand += n; }
  }
  console.log(`  ${'TOTAL'.padEnd(14)} ${grand}`);

  // Remove null sentinels from other bucket before writing
  groups.other = [];

  const out = `// Auto-generated by fetch-japanese-colbase.js
// ${new Date().toISOString()} — ${grand} objects
// ColBase — Japanese National Museums (Tokyo, Kyoto, Nara, Kyushu) — Japanese Ceramics
// Via Japan Search API (jpsearch.go.jp) — CC BY
// To refresh: node fetch-japanese-colbase.js
const JAPANESE_COLBASE_DATA = ${JSON.stringify(groups, null, 2)};
`;
  await writeFile(OUTPUT, out);
  const kb = Math.round(Buffer.byteLength(out) / 1024);
  console.log(`\nWrote ${OUTPUT} (${kb} KB)`);
}

main().catch(console.error);
