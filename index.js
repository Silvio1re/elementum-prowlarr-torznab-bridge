#!/usr/bin/env node
/**
 * prowlarr-jackett-proxy
 * v2.7.1 - Tiered filter s rezervacijom slotova za niže rezolucije
 *          (4K cap + reserved lower slots + spillover)
 */

const http = require("http");

const PORT                  = Number(process.env.PORT || "9117");
const PROWLARR_URL          = (process.env.PROWLARR_URL || "http://127.0.0.1:9696").replace(/\/+$/, "");
const PUBLIC_PROWLARR_URL   = (process.env.PUBLIC_PROWLARR_URL || PROWLARR_URL).replace(/\/+$/, "");
const STREMIOARR_URL        = (process.env.STREMIOARR_URL || "").replace(/\/+$/, "");
const PROWLARR_API_KEY      = process.env.PROWLARR_API_KEY || "";
const FAKE_API_KEY          = process.env.FAKE_API_KEY || "prowlarr-proxy";
const DEBUG                 = process.env.DEBUG === "1" || process.env.DEBUG === "true";

const VERSION = "2.7.1";

// Konfiguracija tiered filtera (env override)
const RESOLUTION_PRIORITY     = (process.env.RESOLUTION_PRIORITY || "4k,1080p,720p").trim();
const RESOLUTION_MIN_SEEDERS  = (process.env.RESOLUTION_MIN_SEEDERS || "5,3,1").trim();
const MAX_SIZE_4K_GB          = Number(process.env.MAX_SIZE_4K_GB || "25");
const RESERVED_LOWER_SLOTS_PCT = Number(process.env.RESERVED_LOWER_SLOTS_PCT || "50");

const MAX_RESULTS         = Number(process.env.MAX_RESULTS || "30");
const MAX_RESULTS_TV      = Number(process.env.MAX_RESULTS_TV || "30");
const PREFETCH_TIMEOUT_MS = 30000;
const FETCH_TIMEOUT_MS    = 8000;
const PROWLARR_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 15000;
const STREMIO_TIMEOUT_MS  = 20000;
const MAX_REDIRECT_HOPS   = 8;
const MIN_SEEDERS         = Number(process.env.MIN_SEEDERS || "1");

const BAD_RESOLUTION_REGEX = /\b(480p|360p|240p|144p|cam|ts|telesync|telecine|screener|scr|hdts|hdcam|dvdscr)\b/i;

const magnetCache = new Map();
const prefetchQueue = new Map();

function log(...a)  { console.log(new Date().toISOString(), ...a); }
function dbg(...a)  { if (DEBUG) console.log(new Date().toISOString(), "[debug]", ...a); }

function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// TIERED FILTER — 4K cap + rezervirani slotovi za niže tiere
// ============================================================
function parseTiers() {
  if (!RESOLUTION_PRIORITY || RESOLUTION_PRIORITY.toLowerCase() === "none") {
    return null; // staro ponašanje
  }

  const names = RESOLUTION_PRIORITY.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const seeders = RESOLUTION_MIN_SEEDERS.split(",").map(s => Number(s.trim()));

  const regexMap = {
    "4k":     /\b(2160p|4k|uhd)\b/i,
    "2160p":  /\b(2160p|4k|uhd)\b/i,
    "uhd":    /\b(2160p|4k|uhd)\b/i,
    "1080p":  /\b1080p\b/i,
    "720p":   /\b720p\b/i,
    "480p":   /\b480p\b/i,
  };

  return names.map((name, i) => ({
    name,
    regex: regexMap[name] || new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    minSeeders: Number.isFinite(seeders[i]) ? seeders[i] : 1,
    maxSize: (name === "4k" || name === "2160p" || name === "uhd") ? MAX_SIZE_4K_GB * 1024 ** 3 : undefined,
  }));
}

function applyTieredFilter(releases, tiers, maxResults) {
  // 1. Razvrstaj po tieru (4K, 1080p, 720p) s filterima
  const tierBuckets = tiers.map(tier => ({
    tier,
    items: releases
      .filter(r => {
        const title = String(r.title || "");
        if (!tier.regex.test(title)) return false;
        if (Number(r.seeders || 0) < tier.minSeeders) return false;
        const size = Number(r.size || 0);
        if (tier.maxSize && size > 0 && size > tier.maxSize) return false;
        return true;
      })
      .sort((a, b) => Number(b.seeders || 0) - Number(a.seeders || 0))
  }));

  // 2. Rezerviraj pola slotova za niže tiere
  const reservedSlots = Math.floor(maxResults * RESERVED_LOWER_SLOTS_PCT / 100);
  const maxTopSlots = maxResults - reservedSlots;

  const used = tierBuckets.map(() => 0);

  // 3. 4K (top tier) dobiva do maxTopSlots
  if (tierBuckets.length > 0) {
    used[0] = Math.min(tierBuckets[0].items.length, maxTopSlots);
  }

  // 4. Niži tieri (1080p, 720p) pune rezervirane slotove
  let lowerUsed = 0;
  for (let i = 1; i < tierBuckets.length; i++) {
    if (lowerUsed >= reservedSlots) break;
    const canAdd = Math.min(
      tierBuckets[i].items.length,
      reservedSlots - lowerUsed
    );
    used[i] = canAdd;
    lowerUsed += canAdd;
  }

  // 5. Spillover — ako niži tieri nisu popunili svoj rezervirani dio, 4K dobiva ostatak
  let totalUsed = used.reduce((a, b) => a + b, 0);
  let remaining = maxResults - totalUsed;
  for (let i = 0; i < tierBuckets.length && remaining > 0; i++) {
    const avail = tierBuckets[i].items.length - used[i];
    const canAdd = Math.min(avail, remaining);
    used[i] += canAdd;
    remaining -= canAdd;
  }

  // 6. Složi rezultat u tier redu (4K prvo, pa 1080p, pa 720p)
  const result = [];
  for (let i = 0; i < tierBuckets.length; i++) {
    if (used[i] > 0) {
      result.push(...tierBuckets[i].items.slice(0, used[i]));
    }
    dbg(`[tier] ${tierBuckets[i].tier.name}: ${tierBuckets[i].items.length} kandidata (min ${tierBuckets[i].tier.minSeeders} seedera${tierBuckets[i].tier.maxSize ? `, max ${MAX_SIZE_4K_GB} GB` : ""}), dodano ${used[i]}`);
  }

  if (result.length === 0) {
    dbg(`[tier] ⚠️ Nijedan item ne prolazi tiered filter — prazna lista`);
  }

  dbg(`[tier-filter] Ukupno ${result.length}/${maxResults} (4K cap ${maxTopSlots}, reserved lower ${reservedSlots})`);
  return result;
}

// ============================================================
// TORZNAB XML PARSER (za StremioArrs)
// ============================================================
function parseTorznabXml(xml) {
  const releases = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const title = extractTag(item, "title");
    if (!title) continue;

    const guid     = extractTag(item, "guid");
    const link     = extractTag(item, "link");
    const sizeStr  = extractTag(item, "size");
    const catStr   = extractTag(item, "category");
    const pubDate  = extractTag(item, "pubDate");

    const infohash = extractAttr(item, "infohash");
    const seeders  = extractAttr(item, "seeders");
    const imdbid   = extractAttr(item, "imdbid");

    const release = {
      title,
      guid: guid || link,
      size: Number(sizeStr) || 0,
      seeders: Number(seeders) || 0,
      infoHash: infohash || undefined,
      indexer: "StremioArrs",
      publishDate: pubDate,
      imdbId: imdbid || undefined,
      categories: catStr ? [{ id: Number(catStr), name: "" }] : [],
    };

    if (link && link.startsWith("magnet:")) {
      release.magnetUrl = link;
    } else if (link && link.startsWith("http")) {
      release.downloadUrl = link;
    } else if (guid && guid.startsWith("magnet:")) {
      release.magnetUrl = guid;
    } else if (infohash) {
      release.magnetUrl = `magnet:?xt=urn:btih:${infohash}&dn=${encodeURIComponent(title)}`;
    }

    releases.push(release);
  }

  return releases;
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : "";
}

function extractAttr(xml, attrName) {
  const m = xml.match(new RegExp(`<[a-zA-Z0-9]+:attr[^>]*name="${attrName}"[^>]*value="([^"]*)"`));
  return m ? m[1] : "";
}

function dedupeByHash(releases) {
  const seen = new Set();
  return releases.filter(r => {
    const key = r.infoHash || r.magnetUrl || r.guid || r.downloadUrl || r.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================
// MAGNET RESOLUTION
// ============================================================
async function resolveMagnetOrTorrent(release) {
  if (release.magnetUrl && release.magnetUrl.startsWith("magnet:")) {
    return { type: "magnet", value: release.magnetUrl };
  }
  if (release.infoHash) {
    return {
      type: "magnet",
      value: `magnet:?xt=urn:btih:${release.infoHash}&dn=${encodeURIComponent(release.title || "")}`
    };
  }
  if (!release.downloadUrl) return null;

  const cacheKey = release.downloadUrl;
  if (magnetCache.has(cacheKey)) return magnetCache.get(cacheKey);
  if (prefetchQueue.has(cacheKey)) return prefetchQueue.get(cacheKey);

  const promise = (async () => {
    let currentUrl = release.downloadUrl;
    for (let i = 0; i < MAX_REDIRECT_HOPS; i++) {
      try {
        const r = await fetchWithTimeout(currentUrl, {
          headers: { "X-Api-Key": PROWLARR_API_KEY },
          redirect: 'manual'
        }, DOWNLOAD_TIMEOUT_MS);

        dbg(`[resolve] step ${i}: status=${r.status} location=${r.headers.get('location')?.slice(0, 150)}`);

        if (r.status >= 300 && r.status < 400) {
          let location = r.headers.get('location');
          if (!location) return null;

          if (location.startsWith('magnet:')) {
            const result = { type: "magnet", value: location };
            magnetCache.set(cacheKey, result);
            dbg(`[resolve] MAGNET nađen: ${location.slice(0, 80)}`);
            return result;
          }

          if (!location.startsWith('http')) {
            const baseUrl = new URL(currentUrl);
            location = new URL(location, baseUrl.origin).href;
          }

          const isInternalDocker =
            location.includes('extto-proxy') ||
            location.includes('prowlarr') ||
            location.includes('stremio') ||
            location.startsWith('http://127.0.0.1') ||
            location.startsWith('http://localhost');

          if (isInternalDocker) {
            dbg(`[resolve] Docker interno, pratim dalje: ${location.slice(0, 100)}`);
            currentUrl = location;
            continue;
          }

          const result = { type: "redirect", location };
          magnetCache.set(cacheKey, result);
          dbg(`[resolve] eksterni redirect, vraćam Elementumu: ${location.slice(0, 100)}`);
          return result;
        }

        if (r.ok) {
          const contentType = r.headers.get('content-type') || 'application/x-bittorrent';
          const buf = Buffer.from(await r.arrayBuffer());
          const result = { type: "torrent", buffer: buf, contentType };
          magnetCache.set(cacheKey, result);
          dbg(`[resolve] torrent fajl (${buf.length} bytes)`);
          return result;
        }

        log(`[resolve] HTTP ${r.status} za ${currentUrl.slice(0, 80)}`);
        return null;
      } catch (e) {
        dbg(`[resolve] error: ${e.message}`);
        return null;
      }
    }
    return null;
  })();

  prefetchQueue.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    prefetchQueue.delete(cacheKey);
  }
}

async function prefetchWithLimit(releases, maxTimeMs = PREFETCH_TIMEOUT_MS) {
  const start = Date.now();
  const resolved = [];
  const BATCH = 5;

  for (let i = 0; i < releases.length; i += BATCH) {
    if (Date.now() - start > maxTimeMs - 1500) {
      dbg(`Prefetch timeout, ${resolved.length}/${releases.length} resolved`);
      break;
    }

    const batch = releases.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(r => resolveMagnetOrTorrent(r)));

    results.forEach((res, idx) => {
      if (res.status === "fulfilled" && res.value) {
        if (res.value.type === "magnet") {
          batch[idx].magnetUrl = res.value.value;
          resolved.push(batch[idx]);
        } else if (res.value.type === "torrent") {
          dbg(`[prefetch] torrent keširan: ${batch[idx].title?.slice(0, 60)}`);
        } else if (res.value.type === "redirect") {
          dbg(`[prefetch] eksterni redirect keširan: ${batch[idx].title?.slice(0, 60)}`);
        }
      }
    });

    dbg(`[prefetch] batch ${i}/${releases.length}, magnets=${resolved.length}, elapsed=${Date.now() - start}ms`);
  }

  dbg(`[prefetch] complete: ${resolved.length} magneta u ${Date.now() - start}ms`);
  return resolved;
}

// ============================================================
// BUILD ITEM
// ============================================================
function buildItem(release, req) {
  const title    = release.title || "Unknown";
  const host     = req.headers.host || "127.0.0.1:9117";

  const isRealMagnet = (s) => typeof s === 'string' && s.startsWith('magnet:');
  const isDockerInternal = (s) => typeof s === 'string' && (
    s.includes('prowlarr:') ||
    s.includes('extto-proxy:') ||
    s.includes('stremioarrs:')
  );

  let magnet = "";
  if (isRealMagnet(release.magnetUrl)) {
    magnet = release.magnetUrl;
  }

  let download = release.downloadUrl || "";
  if (!download && isDockerInternal(release.magnetUrl)) {
    download = release.magnetUrl;
  }

  const proxyLink = download ? `http://${host}/proxy_download?url=${encodeURIComponent(download)}` : "";

  if (!magnet && release.infoHash) {
    magnet = `magnet:?xt=urn:btih:${release.infoHash}&dn=${encodeURIComponent(title)}`;
  }

  let guid;
  if (magnet) {
    guid = magnet;
  } else if (release.infoHash) {
    guid = release.infoHash;
  } else {
    guid = proxyLink || title;
  }

  const size     = Number(release.size || 0);
  const seeders  = Math.max(0, Number(release.seeders || 0));
  const leechers = Math.max(0, Number(release.leechers || 0));
  const peers    = seeders + leechers;

  const catList    = Array.isArray(release.categories) ? release.categories : [];
  const primaryCat = catList.length > 0 ? catList[0].id : 8000;

  let pubDate = new Date().toUTCString();
  if (release.publishDate) {
    const d = new Date(release.publishDate);
    if (!isNaN(d.getTime())) pubDate = d.toUTCString();
  }

  const catAttrs = catList
    .map(c => `      <torznab:attr name="category" value="${xmlEscape(c.id)}" />`)
    .join("\n");

  const indexerName = release.indexer || "Prowlarr";

  const magnetAttr   = magnet ? `\n      <torznab:attr name="magneturl" value="${xmlEscape(magnet)}" />` : "";
  const infohashAttr = release.infoHash ? `\n      <torznab:attr name="infohash" value="${xmlEscape(release.infoHash)}" />` : "";
  const indexerAttr  = release.indexer  ? `\n      <torznab:attr name="indexer" value="${xmlEscape(release.indexer)}" />` : "";

  let link = magnet || proxyLink;
  if (!link && release.infoHash) {
    link = `magnet:?xt=urn:btih:${release.infoHash}&dn=${encodeURIComponent(title)}`;
  }

  return `    <item>
      <title>${xmlEscape(title)}</title>
      <jackettindexer id="${xmlEscape(indexerName)}">${xmlEscape(indexerName)}</jackettindexer>
      <guid isPermaLink="false">${xmlEscape(guid)}</guid>
      <link>${xmlEscape(link)}</link>
      <pubDate>${xmlEscape(pubDate)}</pubDate>
      <category>${xmlEscape(primaryCat)}</category>
      <size>${size}</size>
      <enclosure url="${xmlEscape(link)}" length="${size}" type="application/x-bittorrent" />
      <torznab:attr name="seeders" value="${seeders}" />
      <torznab:attr name="peers" value="${peers}" />
      <torznab:attr name="grabs" value="0" />${catAttrs}${magnetAttr}${infohashAttr}${indexerAttr}
    </item>`;
}

function resultsXml(releases, req) {
  const items = releases.map(r => buildItem(r, req)).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Prowlarr via Jackett proxy</title>
    <description>Aggregated results from Prowlarr</description>
    <link>http://${req.headers.host || '127.0.0.1:9117'}</link>
${items}
  </channel>
</rss>`;
}

function mapType(t) {
  switch ((t || "search").toLowerCase()) {
    case "search":   return "search";
    case "tvsearch": return "tvsearch";
    case "movie":    return "movie";
    case "music":    return "music";
    case "book":     return "book";
    default:         return "search";
  }
}

// ============================================================
// PROWLARR SEARCH + STREMIOARRS
// ============================================================
async function prowlarrSearch({ query, type, categories, limit, offset, imdbid, tvdbid, season, ep }) {
  const params = new URLSearchParams();
  if (query)      params.set("query", query);
  if (type)       params.set("type", type);
  if (categories) params.set("categories", categories);
  if (limit)      params.set("limit", String(limit));
  if (offset)     params.set("offset", String(offset));
  if (imdbid)     params.set("imdbid", imdbid);
  if (tvdbid)     params.set("tvdbid", tvdbid);
  if (season)     params.set("season", season);
  if (ep)         params.set("ep", ep);

  const url = `${PROWLARR_URL}/api/v1/search?${params.toString()}`;
  dbg("GET", url);

  const r = await fetchWithTimeout(url, {
    headers: { "X-Api-Key": PROWLARR_API_KEY, accept: "application/json" },
  }, PROWLARR_TIMEOUT_MS);

  const text = await r.text();
  if (!r.ok) throw new Error(`Prowlarr HTTP ${r.status}: ${text.slice(0, 300)}`);

  try { return JSON.parse(text); }
  catch { throw new Error("Prowlarr bad JSON: " + text.slice(0, 300)); }
}

async function stremioarrTvSearch({ query, season, ep, imdbid }) {
  if (!STREMIOARR_URL) return [];

  const params = new URLSearchParams();
  params.set("t", "tvsearch");
  if (query)   params.set("q", query);
  if (season)  params.set("season", String(Number(season)));
  if (ep)      params.set("ep", String(Number(ep)));
  if (imdbid)  params.set("imdbid", imdbid);

  const url = `${STREMIOARR_URL}/api?${params.toString()}`;
  dbg("[stremio] GET", url);

  try {
    const r = await fetchWithTimeout(url, { accept: "application/xml" }, STREMIO_TIMEOUT_MS);
    if (!r.ok) {
      dbg(`[stremio] HTTP ${r.status}`);
      return [];
    }
    const xml = await r.text();
    const releases = parseTorznabXml(xml);
    dbg(`[stremio] ${releases.length} rezultata`);
    return releases;
  } catch (e) {
    log(`[stremio] error: ${e.message}`);
    return [];
  }
}

// ============================================================
// HANDLE API
// ============================================================
async function handleApi(req, res, u) {
  const t = (u.searchParams.get("t") || "search").toLowerCase();

  if (t === "indexers") {
    return send(res, 200, "application/xml; charset=utf-8",
      `<?xml version="1.0" encoding="UTF-8"?>
<indexers>
  <indexer id="all" configured="true">
    <title>All</title>
    <description>All Indexers</description>
    <link>http://localhost:9117</link>
    <language>en-US</language>
    <type>public</type>
    <caps>
      <limits default="100" max="100" />
      <searching>
        <search available="yes" supportedParams="q" />
        <tv-search available="yes" supportedParams="q,season,ep,imdbid,tvdbid" />
        <movie-search available="yes" supportedParams="q,imdbid" />
      </searching>
      <categories>
        <category id="2000" name="Movies" />
        <category id="5000" name="TV" />
      </categories>
    </caps>
  </indexer>
</indexers>`);
  }

  if (t === "caps") {
    return send(res, 200, "application/xml; charset=utf-8", capsXml());
  }

  const given = u.searchParams.get("apikey") || "";
  if (FAKE_API_KEY && given !== FAKE_API_KEY) {
    return send(res, 403, "application/xml; charset=utf-8", errorXml(100, "Invalid API key"));
  }

  let q = u.searchParams.get("q") || "";
  const qOriginal = q;
  const imdbid = u.searchParams.get("imdbid");
  const tvdbid = u.searchParams.get("tvdbid");

  const seasonRaw = u.searchParams.get("season") || "";
  const epRaw     = u.searchParams.get("ep") || "";
  const season = seasonRaw ? seasonRaw.replace(/\D/g, "").padStart(2, "0") : "";
  const ep     = epRaw     ? epRaw.replace(/\D/g, "").padStart(2, "0")     : "";

  if (t === "tvsearch") {
    if (q && season && ep && !/\bS\d{2}E\d{2,3}\b/i.test(q)) {
      q = `${q} S${season}E${ep}`.trim();
    } else if (q && season && !/\bS\d{2}\b/i.test(q)) {
      q = `${q} S${season}`.trim();
    }
  }

  const searchParams = {
    query: q || undefined,
    type: mapType(t),
    categories: undefined,
    limit: 100,
    offset: "0",
    imdbid: imdbid || undefined,
    tvdbid: tvdbid || undefined,
    season: season || undefined,
    ep: ep || undefined,
  };

  dbg("Prowlarr search params:", JSON.stringify(searchParams));

  try {
    const prowlarrPromise = prowlarrSearch(searchParams)
      .catch(e => { log("[prowlarr] error:", e.message); return []; });

    const stremioPromise = (t === "tvsearch" && STREMIOARR_URL && (qOriginal || imdbid))
      ? stremioarrTvSearch({ query: qOriginal, season, ep, imdbid })
      : Promise.resolve([]);

    const [prowlarrReleases, stremioReleases] = await Promise.all([prowlarrPromise, stremioPromise]);

    dbg(`[merge] Prowlarr: ${prowlarrReleases.length}, StremioArrs: ${stremioReleases.length}`);

    let allReleases = dedupeByHash([...prowlarrReleases, ...stremioReleases]);
    dbg(`[merge] nakon dedupe: ${allReleases.length}`);

    if (allReleases.length === 0) {
      dbg("Ukupno 0 rezultata");
      return send(res, 200, "application/rss+xml; charset=utf-8", resultsXml([], req));
    }

    let filtered = allReleases;

    // 1. Global min seeders (default 1)
    if (MIN_SEEDERS > 0) {
      filtered = filtered.filter(r => Number(r.seeders || 0) >= MIN_SEEDERS);
      dbg(`Filtrirano po seederima (global): ${allReleases.length} -> ${filtered.length}`);
    }

    // 2. Exclude bad resolution (cam, ts, 480p)
    const beforeBadRes = filtered.length;
    filtered = filtered.filter(r => !BAD_RESOLUTION_REGEX.test(String(r.title || "")));
    dbg(`Excluded bad resolution: ${beforeBadRes} -> ${filtered.length}`);

    // 3. TV episode filter (SxxExx)
    const seasonNum = Number(season);
    const epNum = Number(ep);
    if (t === "tvsearch" && seasonNum > 0 && epNum > 0) {
      const tvToken = new RegExp(`\\bS${season}E${ep}\\b`, 'i');
      const beforeTvFilter = filtered.length;
      const tvFiltered = filtered.filter(r => tvToken.test(String(r.title || "")));
      if (tvFiltered.length > 0) {
        filtered = tvFiltered;
        dbg(`Filtrirano po TV epizodi (S${season}E${ep}): ${beforeTvFilter} -> ${filtered.length}`);
      } else {
        dbg(`[warn] TV filter sve izbacio, fallback na ${beforeTvFilter}`);
      }
    }

    // 4. Tiered filter (4K cap + reserved lower slots)
    const maxResults = (t === "tvsearch") ? MAX_RESULTS_TV : MAX_RESULTS;
    const tiers = parseTiers();

    let releases;
    if (tiers) {
      releases = applyTieredFilter(filtered, tiers, maxResults);
      dbg(`[tier-filter] Ukupno ${releases.length} rezultata nakon tiered filtera (max ${maxResults})`);
    } else {
      filtered.sort((a, b) => Number(b.seeders || 0) - Number(a.seeders || 0));
      releases = filtered.slice(0, maxResults);
      dbg(`[no-tier] Sortirano po seederima, ograničeno na ${releases.length}`);
    }

    // 5. Prefetch sve koji trebaju magnet
    const needingResolve = releases.filter(r =>
      !r.infoHash &&
      (!r.magnetUrl || !r.magnetUrl.startsWith('magnet:')) &&
      r.downloadUrl
    );

    if (needingResolve.length > 0) {
      dbg(`Prefetch ${needingResolve.length} itema koji trebaju magnet resolution...`);
      const resolved = await prefetchWithLimit(needingResolve, PREFETCH_TIMEOUT_MS);
      dbg(`Riješeno ${resolved.length}/${needingResolve.length}`);
    } else {
      dbg(`Svi itemi već imaju magnet ili infoHash — nema potrebe za prefetch`);
    }

    send(res, 200, "application/rss+xml; charset=utf-8", resultsXml(releases, req));
  } catch (e) {
    log("[error]", e.message);
    return send(res, 500, "application/xml; charset=utf-8", errorXml(900, String(e.message || e)));
  }
}

function capsXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server version="${VERSION}" title="Prowlarr via Jackett proxy" />
  <limits max="100" default="50" />
  <searching>
    <search available="yes" supportedParams="q" />
    <tv-search available="yes" supportedParams="q,season,ep,imdbid,tvdbid" />
    <movie-search available="yes" supportedParams="q,imdbid" />
  </searching>
  <categories>
    <category id="2000" name="Movies" />
    <category id="5000" name="TV" />
    <category id="8000" name="Other" />
  </categories>
</caps>`;
}

function errorXml(code, desc) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<error code="${xmlEscape(code)}" description="${xmlEscape(desc)}" />`;
}

// ============================================================
// PROXY DOWNLOAD
// ============================================================
async function handleProxyDownload(req, res, u) {
  const targetUrl = u.searchParams.get("url");
  if (!targetUrl) {
    return send(res, 400, "text/plain; charset=utf-8", "missing url");
  }

  if (targetUrl.startsWith('magnet:')) {
    res.writeHead(302, { Location: targetUrl });
    return res.end();
  }

  if (magnetCache.has(targetUrl)) {
    const cached = magnetCache.get(targetUrl);
    if (cached.type === "magnet") {
      res.writeHead(302, { Location: cached.value });
      return res.end();
    }
    if (cached.type === "torrent") {
      res.writeHead(200, {
        'content-type': cached.contentType || 'application/x-bittorrent',
        'content-disposition': 'attachment; filename="download.torrent"',
        'content-length': cached.buffer.length,
      });
      return res.end(cached.buffer);
    }
    if (cached.type === "redirect") {
      res.writeHead(302, { Location: cached.location });
      return res.end();
    }
  }

  try {
    const result = await resolveMagnetOrTorrent({ downloadUrl: targetUrl });

    if (!result) {
      log("[proxy_download] no magnet/torrent/redirect");
      return send(res, 502, "text/plain; charset=utf-8", "no magnet/torrent/redirect");
    }

    if (result.type === "magnet") {
      res.writeHead(302, { Location: result.value });
      return res.end();
    }
    if (result.type === "redirect") {
      res.writeHead(302, { Location: result.location });
      return res.end();
    }
    if (result.type === "torrent") {
      res.writeHead(200, {
        'content-type': result.contentType || 'application/x-bittorrent',
        'content-disposition': 'attachment; filename="download.torrent"',
        'content-length': result.buffer.length,
      });
      return res.end(result.buffer);
    }

    return send(res, 502, "text/plain; charset=utf-8", "unknown result type");
  } catch (e) {
    log("[proxy_download] error:", e.message);
    return send(res, 502, "text/plain; charset=utf-8", String(e.message));
  }
}

// ============================================================
// HTTP SERVER
// ============================================================
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");

    if (req.method === "GET" && u.pathname === "/proxy_download") {
      return await handleProxyDownload(req, res, u);
    }

    if (req.method === "GET" && (
        u.pathname === "/api" ||
        u.pathname === "/api/v2.0/indexers/all/results/torznab" ||
        u.pathname === "/api/v2.0/indexers/all/results/torznab/" ||
        u.pathname === "/api/v2.0/indexers/all/results/torznab/api"
    )) {
      return await handleApi(req, res, u);
    }

    if (u.pathname === "/health") {
      return send(res, 200, "application/json; charset=utf-8",
        JSON.stringify({
          ok: true,
          version: VERSION,
          uptime: process.uptime(),
          cacheSize: magnetCache.size,
          stremioarrUrl: STREMIOARR_URL || "(disabled)",
          resolutionPriority: RESOLUTION_PRIORITY,
          resolutionMinSeeders: RESOLUTION_MIN_SEEDERS,
          maxSize4KGB: MAX_SIZE_4K_GB,
          reservedLowerSlotsPct: RESERVED_LOWER_SLOTS_PCT,
        }));
    }

    return send(res, 404, "text/plain; charset=utf-8", "not found");
  } catch (e) {
    return send(res, 500, "text/plain; charset=utf-8", String(e.message || e));
  }
}).listen(PORT, "0.0.0.0", () => {
  log(`prowlarr-jackett-proxy v${VERSION} listening on :${PORT}`);
  log(`  Prowlarr URL: ${PROWLARR_URL}`);
  log(`  Public Prowlarr URL: ${PUBLIC_PROWLARR_URL}`);
  log(`  StremioArrs URL: ${STREMIOARR_URL || "(disabled)"}`);
  log(`  Resolution priority: ${RESOLUTION_PRIORITY}`);
  log(`  Resolution min seeders: ${RESOLUTION_MIN_SEEDERS}`);
  log(`  Max size 4K: ${MAX_SIZE_4K_GB} GB`);
  log(`  Max results (movies): ${MAX_RESULTS}, (TV): ${MAX_RESULTS_TV}`);
  log(`  Reserved lower slots: ${RESERVED_LOWER_SLOTS_PCT}% (${Math.floor(MAX_RESULTS_TV * RESERVED_LOWER_SLOTS_PCT / 100)} od ${MAX_RESULTS_TV})`);
  log(`  v2.7.1: tiered filter s 4K cap + reserved lower slots + spillover`);
});
