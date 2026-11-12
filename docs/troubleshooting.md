# Troubleshooting

Common problems and how to fix them. If your issue isn't here, check [configuration.md](configuration.md) for env-related issues, or [architecture.md](architecture.md) for how the filter works.

---

## First: check the health endpoint

Almost every problem starts with this:

```bash
curl -s http://localhost:9117/health | python3 -m json.tool

You should see "ok": true and your resolved config. If this fails, the bridge isn't running — check docker compose ps and docker logs prowlarr-torznab-bridge.
No results in Elementum

Most common cause: filters inside script.elementum.jackett are still ON.

The bridge does the filtering. If Jackett's own filters are also on, they strip candidates before the bridge ever sees them. With MAX_RESULTS=30 and everything filtered out upstream, the bridge has nothing to fill slots with.

Fix: Kodi → Add-ons → Program add-ons → Elementum Jackett → Configure. Turn OFF all of:

    Filter by Resolution

    Filter by Seeders

    Filter by Size

    Filter by Quality

Save, restart Kodi, try again.

Other causes:
Check	Command
Bridge reachable?	curl http://<host>:9117/health
FAKE_API_KEY matches Elementum?	Compare health output with the key in Elementum's indexer config
Prowlarr has results?	curl -H "X-Api-Key: YOUR_KEY" "http://prowlarr:9696/api/v1/search?query=test&type=search"
Bridge logs show requests?	docker logs -f prowlarr-torznab-bridge

If the logs show no incoming requests when you search in Elementum, the indexer isn't configured correctly — go back to README step 2.
403 Forbidden

FAKE_API_KEY mismatch. The key in script.elementum.jackett must be character-for-character identical to the FAKE_API_KEY env in the bridge.

Common mistakes:

    Trailing space in one but not the other

    Different length (e.g., 31 chars vs 32)

    Elementum field left empty (bridge default is prowlarr-proxy)

Verify:
bash

curl -s "http://localhost:9117/api?t=tvsearch&q=test&apikey=YOUR_KEY" | head -c 200

If you see <error code="100" ...> the key is wrong. If you see RSS, it's right.
Fewer than 30 results

Three possible causes, in order of likelihood:
1. Filters in script.elementum.jackett are on

Same fix as "No results" above. This is by far the most common reason.
2. Not enough candidates upstream

The bridge can't invent torrents. If Prowlarr returns 12 total results, you get 12. Check:
bash

docker logs --tail=50 prowlarr-torznab-bridge | grep -E "tier|merge|Filtrirano"

You'll see lines like:
text

[merge] nakon dedupe: 45
[tier] 4k: 8 kandidata (...), dodano 8
[tier] 1080p: 4 kandidata (...), dodano 4
[tier-filter] Ukupno 12/30 (4K cap 15, reserved lower 15)

If total candidates are low, loosen RESOLUTION_MIN_SEEDERS or MAX_SIZE_4K_GB (see configuration.md).
3. TV episode filter removed everything

For TV searches, the bridge requires SxxExx in the title. If a release uses a different format (2x04, S02 - E04, absolute numbering), it gets dropped.

Detection: log line [warn] TV filter sve izbacijo, fallback na N means the filter was empty and the bridge reverted to the unfiltered set. If you see this, the source titles don't use SxxExx — check what Prowlarr returns directly.
All results are 4K

RESERVED_LOWER_SLOTS_PCT=0 — you disabled reservation. Either that or Prowlarr has no 1080p/720p candidates at all (rare for new shows).

Fix: set RESERVED_LOWER_SLOTS_PCT=50 (or whatever you prefer) and restart.
bash

docker compose restart prowlarr-torznab-bridge

Results aren't sorted correctly

The bridge always outputs 4K → 1080p → 720p, each tier internally sorted by seeders. If Elementum shows a different order, it's re-sorting.

Check script.elementum.jackett → Configure → Sort by. Leave it at whatever default — the bridge's order is what should win.

Note: Elementum may also sort by name/date if its UI setting overrides — that's client-side and out of the bridge's control.
Slow first search (30+ seconds)

Some searches block on magnet resolution. When Prowlarr returns HTTP download URLs (no infohash), the bridge must resolve them into magnets before returning XML — that's the prefetch stage.

Symptoms: first search is slow, subsequent searches for the same query are instant (magnet cache hit).

Options:

    Wait it out — resolution is capped at 30 seconds total.

    Lower the timeout — set PREFETCH_TIMEOUT_MS (undocumented but works, 30000 default). Lower = faster returns but more failed resolutions.

    Prefer sources with infohashes — not configurable, but torrents with infohash in Prowlarr never need resolution.

Check the logs:
bash

docker logs -f prowlarr-torznab-bridge | grep -E "prefetch|resolve"

Magnet links don't work in Elementum

The bridge generates magnets and proxies /proxy_download but Elementum is what actually opens them. Common causes:
magnetUrl attribute missing

Some clients require <torznab:attr name="magneturl">. The bridge includes it when available. If a specific release lacks it (only has downloadUrl), Elementum will use /proxy_download instead, which should work but adds a hop.
External redirect fails

If /proxy_download returns 502 no magnet/torrent/redirect, the tracker's redirect target is unreachable from the bridge. Check the logs:
bash

docker logs prowlarr-torznab-bridge | grep proxy_download

If the target is Docker-internal, the bridge follows it. If external, it 302s to it. If external is also broken, the bridge gives up — try a different release.
FAKE_API_KEY blocks /proxy_download

/proxy_download doesn't check the API key (it's used by the Kodi client directly), so this isn't usually the issue. But if the bridge is behind a reverse proxy with auth, ensure /proxy_download is accessible.
Bridge container won't start
bash

docker logs prowlarr-torznab-bridge

Common errors:
Error	Cause
EADDRINUSE :9117	Another service on port 9117. Change PORT env or stop the conflict.
Cannot find module 'http'	Broken Node install (very rare) — rebuild the image
Exit code 0 immediately	Container ran but exited — check if restart: unless-stopped is set
Logs are silent

By default the bridge logs only startup and errors. Enable debug:
yaml

environment:
  - DEBUG=1

Then docker compose up -d (recreate, not restart — env changes need up).

With debug on, every search produces ~15 log lines showing the filter funnel:
text

[merge] Prowlarr: 45, StremioArrs: 12
[merge] nakon dedupe: 51
Filtrirano po seederima (global): 51 -> 48
Excluded bad resolution: 48 -> 48
Filtrirano po TV epizodi (S02E04): 48 -> 46
[tier] 4k: 30 kandidata (min 5 seedera, max 25 GB), dodano 15
[tier] 1080p: 18 kandidata (min 3 seedera), dodano 15
[tier] 720p: 0 kandidata (min 1 seedera), dodano 0
[tier-filter] Ukupno 30/30 (4K cap 15, reserved lower 15)
Prefetch 6 itema koji trebaju magnet resolution...
Riješeno 6/6

This is the fastest way to diagnose almost any issue.
Season packs appear as single episodes

Known limitation. A torrent named Breaking.Bad.S01-S05.Complete.1080p might be reported by Prowlarr with the size of a single episode (e.g., 843 MB), so it passes all filters and shows up as if it were one episode. Clicking it in Elementum would start a 100+ GB download.

A season-pack filter is drafted for v2.7.2 but not active by default. Until it ships, manually ignore releases whose titles contain Complete, S01-S05, or similar markers before clicking.
Still stuck?

Collect this and open an issue:
bash

# 1. Health + config
curl -s http://localhost:9117/health | python3 -m json.tool

# 2. Last 100 log lines with debug on
docker logs --tail=100 prowlarr-torznab-bridge

# 3. The exact search that failed
curl -s "http://localhost:9117/api?t=tvsearch&q=YOURSHOW&season=X&ep=Y&apikey=YOURKEY" | head -100

# 4. Elementum's indexer config (screenshot)
#    Kodi → Elementum Jackett → Configure → Indexers

Include what you expected vs. what you got. Most issues are "filters in script.elementum.jackett are on" — check that first.
