# Architecture

Technical overview of the Prowlarr Torznab Bridge — what it does, how data flows through it, and why it's built this way.

> Configuration details are in [configuration.md](configuration.md). Troubleshooting is in [troubleshooting.md](troubleshooting.md).

---

## What the bridge is

A single-file Node.js process (~600 lines, zero dependencies) that sits between Elementum and Prowlarr. It speaks Torznab on both sides: Elementum thinks it's talking to Jackett, and the bridge talks to Prowlarr as if it were any other Torznab client.

The bridge exists because **there is no native Elementum ↔ Prowlarr integration**. `script.elementum.jackett` only speaks Torznab to Jackett-style servers, and it applies its own filters before any request leaves Kodi. Even if you pointed it at Prowlarr directly, you couldn't get:

- Resolution priority (4K first, then 1080p, then 720p)
- Per-tier seeders and size limits
- Reserved slots so lower resolutions always get a chance
- A guaranteed full list (up to MAX) with a sane resolution mix

The bridge fills that gap.

---

## Where it fits

```mermaid
flowchart LR
    K[Kodi] -->|plugin://| E[Elementum addon]
    E -->|Torznab| J[script.elementum.jackett]
    J -->|Torznab| B[Prowlarr Torznab Bridge :9117]
    B -->|REST| P[Prowlarr :9696]
    B -->|Torznab| S[StremioArrs :5100]
script.elementum.jackett still runs — it just points at the bridge instead of Jackett. All filters inside script.elementum.jackett must be OFF (see README), because the bridge does the filtering now. If those filters stay on, the bridge never sees the full candidate set and can't fill its reserved slots correctly.

The bridge does not download anything. It only proxies searches and resolves magnets. Actual torrenting happens in Elementum.
Request lifecycle

One search goes through eleven stages:

    Route match — /api is the Torznab endpoint, /proxy_download resolves magnets/torrents, /health returns JSON status.

    Auth check — plain string comparison against FAKE_API_KEY. Not cryptographic, not meant to be.

    Query normalization — season=2&ep=4 becomes S02E04, appended to q if not already there.

    Parallel upstream fetch — Prowlarr and StremioArrs are queried at the same time via Promise.all. Each side fails independently: if Prowlarr is down, StremioArrs results still come through.

    Deduplication — cascading key infoHash || magnetUrl || guid || downloadUrl || title.

    Global min-seeders — default MIN_SEEDERS=1, removes dead torrents.

    Bad resolution filter — blacklist for cam, ts, 480p, etc.

    TV episode filter — strict SxxExx matching for TV searches. If this filter removes everything, the bridge logs a warning and reverts to the pre-filter set, so over-aggressive matching never produces an empty result.

    Tiered filter — the core of the bridge (below).

    Prefetch — resolves magnets for items that only have HTTP download URLs. Batched, timeout-bounded.

    XML serialization — each release becomes a Torznab <item> with <guid>, <link>, <enclosure>, and the seeders, infohash, magneturl attributes.

Stages 1–9 are effectively instant. Stage 10 is the only one that can take seconds.
The tiered filter

This is why the bridge exists. It runs in five phases.

Phase 1 — Bucket. For each tier (4K, 1080p, 720p by default), filter by regex, min seeders, and max size. Sort each bucket by seeders descending.

Phase 2 — Cap. Compute reservedSlots = maxResults * RESERVED_LOWER_SLOTS_PCT / 100. With MAX=30 and PCT=50, reservedSlots = 15 and maxTopSlots = 15. This means 4K can take at most 15 slots.

Phase 3 — Fill top. used[0] = min(4K_candidates, maxTopSlots). If 51 4K torrents are available, take 15. If 11 are available, take all 11.

Phase 4 — Fill lower. Go through 1080p then 720p, filling up to reservedSlots total across all lower tiers. 1080p gets first chance at the 15 slots; 720p gets whatever's left.

Phase 5 — Spillover. If lower tiers can't fill their reserved slots, the leftover goes back to 4K. Otherwise a popular new show with 50× 4K and 0× 1080p would return only 15 results instead of 30.

Phase 6 — Assemble. Output is 4K → 1080p → 720p, each tier internally sorted by seeders.

Worked example — MobLand S02E04 (51× 4K, ~30× 1080p, 0× 720p):
Tier	Available	Used
4K	51	15
1080p	30	15
720p	0	0
Total		30

Worked example — Breaking Bad S01E01 (11× 4K, 30× 1080p, 0× 720p):
Tier	Available	Used
4K	11	11 + 4 spillover = 15
1080p	30	15
720p	0	0
Total		30

The algorithm is the whole point of the bridge. Everything else is plumbing to support it.
Magnet resolution

Elementum needs a magnet URI. Prowlarr returns one of four things:

    Direct magnet — pass through.

    Info hash only — construct magnet:?xt=urn:btih:HASH&dn=TITLE.

    Prowlarr download URL — resolve by following redirects server-side.

    External redirect URL — resolve by following redirects server-side.

Resolution is a loop with a max of MAX_REDIRECT_HOPS iterations. At each hop, one of three things happens:

    The response is a 302 to a magnet — done, cache it, return.

    The response is a 302 to a Docker-internal URL (prowlarr:9696, stremioarrs:5100) — follow it, because Elementum on the Kodi host can't reach those.

    The response is a 302 to an external URL — return the redirect to Elementum, don't download.

    The response is 200 with a .torrent — cache the buffer, serve it via /proxy_download.

Resolved results land in magnetCache, keyed by download URL. This cache grows unbounded — no eviction policy yet. For a home setup restarting occasionally, that's fine (a few MB per restart). For long-running deployments, an LRU would be needed; it's a known limitation.
State

Two in-memory maps, both process-local, both lost on restart:

    magnetCache — download URL → resolved magnet/torrent/redirect. Unbounded.

    prefetchQueue — download URL → in-flight Promise. Bounded (entries removed after completion).

There is no persistent state. No database, no config files, no session store. Restart the container and everything starts fresh.
Design decisions

Zero dependencies. Only require('http'). No npm install, no node_modules, no supply chain risk. Trade-off: no unit tests, no TypeScript, no linter. For a personal tool, acceptable.

Single file. Everything visible at once. Splitting into ten modules would require passing a context object everywhere for little gain.

Fail-soft. Prowlarr down → log and continue with StremioArrs. Both down → return empty RSS with 200. A magnet fails to resolve → skip it, use the others. No automatic retries — Elementum will retry on the next user search, and retries inside the bridge would amplify load during outages.

Env-only config. No config files, no hot reload. Change an env var, restart the container. Configuration details are in configuration.md.

FAKE_API_KEY is not real auth. It's a shared secret between Elementum and the bridge, intended for trusted local networks or Tailscale. If you expose the bridge to the internet, use a strong random key — but ideally don't expose it at all.

Regex XML parser. parseTorznabXml() uses regex, not a real XML parser, because StremioArrs output is predictable and we only extract six tags. Safe here, but breaks silently if the upstream format ever changes.
Known limitations

    Unbounded magnet cache — memory grows with unique searches.

    No season-pack detection — a "Complete S01-S05" torrent may appear as a single episode result. Drafted for v2.7.2, not active by default.

    Single-threaded — one slow Prowlarr response can back up requests. Promise.all mitigates the worst case; horizontal scaling is out of scope.

    No metrics endpoint — only /health and container logs.

Future work

    v2.7.2 — season-pack filter (log / filter / off modes, strict mode optional).

    v2.7.3 — LRU cache for magnets.

    v2.8.0 — Prometheus metrics.

    v2.9.0 — provider abstraction so Jackett, Sonarr, Radarr can be plugged in alongside Prowlarr.

Summary

The bridge turns Prowlarr's flat, seeders-sorted list into Elementum's tiered, magnet-resolved expectation. The core is applyTieredFilter() — five phases that bucket, cap, fill, spill over, and assemble. Everything else is plumbing: parallel fetch, dedupe, magnet resolution, XML serialization. Design philosophy is fail-soft, zero dependencies, env-only config, and aggressive simplicity. It's built for one Kodi client on a home network, and every decision reflects that scope.
