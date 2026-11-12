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
