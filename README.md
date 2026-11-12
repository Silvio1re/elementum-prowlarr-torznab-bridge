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

---

## ⚠️ Before you start — disable existing filters in `script.elementum.jackett`

**This is the most important step. If you skip it, the bridge will not work correctly.**

The `script.elementum.jackett` addon has its **own filter settings** that run **before** the request ever reaches our bridge. If those filters are active, the bridge never sees the full set of candidates and **cannot correctly fill the reserved slots** — you'll get fewer than 30 results or the wrong resolution mix.

**You must turn off ALL of these filters in `script.elementum.jackett`:**

**Kodi → Add-ons → Program add-ons → Elementum Jackett → Configure:**

| Setting | Set to | Why |
|---|---|---|
| **Filter by Resolution** | ❌ **OFF** | The bridge does tiered filtering |
| **Filter by Seeders** | ❌ **OFF** | The bridge does per-tier min seeders |
| **Filter by Size** | ❌ **OFF** | The bridge does max size for 4K |
| **Filter by Quality** | ❌ **OFF** | The bridge excludes cam/ts/480p |
| **Sort by** | anything | The bridge sorts by resolution |

After changing these settings, **save and restart Kodi** before proceeding to the next step.

> 💡 **Rule of thumb:** the bridge should be the **only** thing doing filtering. Let `script.elementum.jackett` pass everything through untouched, and let the bridge decide what makes the final list.

---

## Architecture
