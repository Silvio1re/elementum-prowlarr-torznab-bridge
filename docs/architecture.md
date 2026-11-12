# Prowlarr Torznab Bridge

A Torznab proxy that connects **Elementum** (Kodi) to **Prowlarr** and adds an advanced **tiered resolution filter** (4K → 1080p → 720p) with size and seeder control.

## Why?

**There is no native Elementum ↔ Prowlarr integration.** Elementum communicates with torrent indexers exclusively through the `script.elementum.jackett` addon, which supports **only the Jackett (Torznab) protocol**. Prowlarr *is* Torznab-compatible, but direct connection isn't possible because:

- The Elementum Jackett addon has its **own filters** (resolution, seeders, size) that run before the request ever reaches Prowlarr
- There is **no way** to say "give me max 15× 4K and 15× 1080p"
- There is **no size filter** for 4K — a 60 GB remux passes through untouched
- There is **no resolution priority** — it sorts by seeders, so a 4K with 10 seeders can end up below a 1080p with 100 seeders
- There is **no fallback logic** — if 4K doesn't have enough, it doesn't fill in with 1080p/720p

This bridge solves that — it sits **between** Elementum and Prowlarr and does the tiered filtering for you. **As far as we know, this is the first publicly available implementation of such a bridge.**

## Architecture

**Key point:** the bridge **replaces** Jackett in Elementum's chain. Instead of Elementum calling Jackett (which then calls Prowlarr), Elementum calls **our bridge**, which then calls Prowlarr.

## Features

- ✅ **Tiered filter**: 4K → 1080p → 720p with per-tier min seeders
- ✅ **4K cap + reserved slots**: e.g., 15× 4K + 15× 1080p (instead of 30× 4K)
- ✅ **Max 4K size**: filters out remuxes >25 GB
- ✅ **Multi-source**: Prowlarr + StremioArrs
- ✅ **Magnet resolution**: automatically converts .torrent redirects to magnets
- ✅ **TV episode filter**: strict SxxExx matching
- ✅ **Health endpoint**: `/health` for monitoring
- ✅ **Env-configurable**: everything without a rebuild

## Connecting to Elementum (important!)

This bridge **replaces** Jackett in Elementum's chain. The setup has 4 steps.

### 1. Turn off all filters in `script.elementum.jackett`

**Kodi → Add-ons → Program add-ons → Elementum Jackett → Configure:**

| Setting | Set to | Why |
|---|---|---|
| **Filter by Resolution** | ❌ **OFF** | The bridge does tiered filtering |
| **Filter by Seeders** | ❌ **OFF** | The bridge does per-tier min seeders |
| **Filter by Size** | ❌ **OFF** | The bridge does max size for 4K |
| **Filter by Quality** | ❌ **OFF** | The bridge excludes cam/ts/480p |
| **Sort by** | anything | The bridge sorts by resolution |

**Why is this critical?** If the Jackett addon filters before the request reaches the bridge, the bridge doesn't see all candidates and **cannot correctly fill the reserved slots**. Result: you get fewer than 30 results or the wrong resolution mix.

### 2. Add the bridge as an indexer in Elementum

**Kodi → Add-ons → Program add-ons → Elementum Jackett → Configure → Indexers:**

1. Click **Add indexer** → select **Custom / Torznab** (or **Jackett** if Custom isn't available)
2. **URL**: `http://<docker-host>:9117/api`
   - Locally: `http://192.168.2.119:9117/api`
   - Over Tailscale: `http://prowlarr-proxy-ts:9117/api`
3. **API key**: **any 32-character string**
   - Example: `00000000000000000000000000000000` (32 zeros)
   - Or: `abcdef1234567890abcdef1234567890`
   - **Must match** `FAKE_API_KEY` in the bridge config (see step 3)
4. **Categories**: leave empty (the bridge forwards everything)
5. Click **Save** and **restart Kodi**

### 3. Set `FAKE_API_KEY` in the bridge

In the bridge service's `docker-compose.yml`:

```yaml
environment:
  - FAKE_API_KEY=00000000000000000000000000000000  # same as in Elementum
What is FAKE_API_KEY? It is not the real Prowlarr API key. It's the key the bridge uses to verify that the request is coming from your Elementum. It can be any string, but it must be identical in two places:

    In script.elementum.jackett (step 2, "API key" field)

    In the bridge (step 3, FAKE_API_KEY env)

    ⚠️ Security note: If the bridge is exposed only on your local network or over Tailscale, the key is mostly a formality. If it's exposed to the internet, use a random 32-char string (e.g., generate with openssl rand -hex 16).

4. Restart Elementum

After you change the indexer in script.elementum.jackett:

    Shut down and start Kodi (safest), or

    Restart the Elementum addon

The new indexer should be visible in search. Verify:

    Search for MobLand S02E04 → you should see 15× 4K + 15× 1080p

    Search for Breaking Bad S01E01 → you should see a mix (less 4K, more 1080p)

If you see 30 results with the correct resolution mix → the bridge is working properly.
