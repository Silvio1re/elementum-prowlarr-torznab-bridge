# Configuration

All configuration is via **environment variables**, read once at startup. No config files, no hot reload — change an env var, restart the container.

For how the filtering algorithm uses these values, see [architecture.md](architecture.md).

---

## Quick reference

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9117` | HTTP listen port |
| `PROWLARR_URL` | `http://127.0.0.1:9696` | Prowlarr API URL (internal) |
| `PROWLARR_API_KEY` | _(empty)_ | Real Prowlarr API key |
| `FAKE_API_KEY` | `prowlarr-proxy` | Elementum → bridge shared secret |
| `STREMIOARR_URL` | _(empty)_ | Optional StremioArrs URL |
| `RESOLUTION_PRIORITY` | `4k,1080p,720p` | Tier order |
| `RESOLUTION_MIN_SEEDERS` | `5,3,1` | Min seeders per tier (matched by position) |
| `MAX_SIZE_4K_GB` | `25` | Max 4K torrent size in GB |
| `RESERVED_LOWER_SLOTS_PCT` | `50` | % of slots reserved for non-4K tiers |
| `MAX_RESULTS` | `30` | Max results for movies |
| `MAX_RESULTS_TV` | `30` | Max results for TV |
| `MIN_SEEDERS` | `1` | Global minimum seeders (all tiers) |
| `DEBUG` | `0` | Set to `1` for verbose logging |

---

## Required

Three variables have no sensible default and must be set:

```yaml
environment:
  - PROWLARR_URL=http://prowlarr:9696        # where Prowlarr lives
  - PROWLARR_API_KEY=abc123...              # your real Prowlarr API key
  - FAKE_API_KEY=00000000000000000000000000000000  # shared with Elementum

FAKE_API_KEY can be any string. It must be identical to the API key you enter in script.elementum.jackett (README step 2). Generate one with:
bash

openssl rand -hex 16   # → 32 hex chars

Optional
STREMIOARR_URL

If you run StremioArrs, point the bridge at it to pull extra TV results:
yaml

- STREMIOARR_URL=http://stremioarrs:5100

If unset, the bridge queries Prowlarr only. TV searches are the only ones that use StremioArrs.
DEBUG

Verbose logging. Useful for debugging filter behavior:
yaml

- DEBUG=1

Logs include [tier], [season-pack], [prefetch], [resolve] prefixes.
Tuning the filter

The filtering behavior is controlled by four variables that work together.
RESOLUTION_PRIORITY

Comma-separated tier order. Case-insensitive. Recognized names: 4k, 2160p, uhd, 1080p, 720p, 480p.
yaml

- RESOLUTION_PRIORITY=4k,1080p,720p        # default
- RESOLUTION_PRIORITY=1080p,720p           # skip 4K entirely
- RESOLUTION_PRIORITY=4k,1080p             # no 720p fallback

Set to none to disable tiering entirely — the bridge falls back to sorting by seeders and slicing to MAX_RESULTS.
RESOLUTION_MIN_SEEDERS

Per-tier minimums, matched by position to RESOLUTION_PRIORITY. Three tiers → three numbers.
yaml

- RESOLUTION_MIN_SEEDERS=5,3,1             # default: 4K≥5, 1080p≥3, 720p≥1
- RESOLUTION_MIN_SEEDERS=10,5,2            # strict
- RESOLUTION_MIN_SEEDERS=1,1,1             # permissive

If you list fewer numbers than tiers, the remaining tiers default to 1.
MAX_SIZE_4K_GB

Only applied to the first tier if its name is 4k, 2160p, or uhd. Filters out remuxes and oversized releases.
yaml

- MAX_SIZE_4K_GB=25                       # default
- MAX_SIZE_4K_GB=40                       # allow larger 4K
- MAX_SIZE_4K_GB=0                        # disable size limit

Torrents with size=0 (unknown) always pass — the size check is size > 0 && size > limit.
RESERVED_LOWER_SLOTS_PCT

Percentage of MAX_RESULTS reserved for all tiers below the first. This is what prevents 4K from monopolizing the list.
Value	Effect (with MAX=30)
0	All 30 slots go to 4K first — old v2.7.0 behavior
33	4K can take ~20, lower tiers get ~10
50	4K capped at 15, lower tiers get 15 (default)
67	4K capped at 10, lower tiers get 20
100	4K gets 0 slots — only lower tiers

Spillover still applies: if lower tiers can't fill their reservation, 4K gets the leftover. So PCT=50 with no 1080p available means 4K gets all 30, not just 15.
Common configurations
Balanced (default)

Good for most users.
yaml

environment:
  - RESERVED_LOWER_SLOTS_PCT=50
  - MAX_SIZE_4K_GB=25
  - MAX_RESULTS_TV=30

Result: 15× 4K + 15× 1080p for popular shows, more 4K when 1080p is scarce.
4K-heavy

Fewer 1080p options, more 4K.
yaml

environment:
  - RESERVED_LOWER_SLOTS_PCT=33
  - MAX_SIZE_4K_GB=40

Result: ~20× 4K + 10× 1080p. Larger 4K releases allowed.
Small-files-first

Prioritize smaller torrents for faster streaming.
yaml

environment:
  - RESERVED_LOWER_SLOTS_PCT=67
  - MAX_SIZE_4K_GB=15

Result: ~10× 4K (small ones only) + 20× 1080p.
No 4K (slow connection / small storage)
yaml

environment:
  - RESOLUTION_PRIORITY=1080p,720p
  - RESOLUTION_MIN_SEEDERS=3,1
  - RESERVED_LOWER_SLOTS_PCT=0

Result: 30× 1080p/720p mix. No 4K at all.
Strict

Only well-seeded releases, tight 4K size limit.
yaml

environment:
  - RESOLUTION_MIN_SEEDERS=10,5,2
  - MAX_SIZE_4K_GB=20
  - MIN_SEEDERS=2

Result: fewer results, higher quality average, less dead torrents.
Validation

The bridge does no validation of env values. If you set RESOLUTION_PRIORITY=4k,abc,720p and don't define abc in the tier regex map, the regex falls back to new RegExp(name, 'i') — which will match literally "abc" in titles and probably never hit. Silent misbehavior.

If you set RESERVED_LOWER_SLOTS_PCT=200, reservedSlots will exceed maxResults and the 4K cap becomes negative — the bridge still returns something, but the result is not what you'd expect.

After any change, verify with:
bash

curl -s http://localhost:9117/health | python3 -m json.tool

The health endpoint echoes the resolved config so you can confirm it took effect.
What needs a restart

Everything. The bridge reads env vars once at startup. To apply changes:
bash

docker compose restart prowlarr-torznab-bridge

or, in Portainer: Update the stack.

There is no hot reload and no plan to add one — the filtering algorithm assumes these values don't change mid-request.
