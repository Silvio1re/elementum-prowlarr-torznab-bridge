markdown

# Troubleshooting

## Prowlarr logovi pokazuju Cloudflare 521/522

**Simptom:**

HTTP Error - Res: HTTP/2.0 [GET] https://prowlarr.servarr.com/v1/time: 522
HTTP Error - Res: HTTP/2.0 [GET] https://prowlarr.servarr.com/v1/update/...: 521
text


**Uzrok:** `prowlarr.servarr.com` je privremeno nedostupan (problem na njihovoj strani).

**Utjecaj:** Nema utjecaja na rad Prowlarr-a. Greške se odnose samo na provjeru vremena i dostupnost ažuriranja.

**Rješenje:**
- Ignoriraj (prolazno je)
- Ili isključi `Settings → General → Updates → Check for updates` u Prowlarr-u

---

## Elementum prikazuje praznu listu

**Mogući uzroci:**

1. **Proxy nije pokrenut**
   ```bash
   curl http://127.0.0.1:9117/health
   # → {"ok": true, ...}

    Prowlarr API key nije postavljen
    Provjeri PROWLARR_API_KEY u env.

    Nema rezultata za tu epizodu/film
    Provjeri log: docker logs prowlarr-torznab-bridge | grep "0 rezultata"

    Svi filtrirani (min seeders previsok)
    Smanji RESOLUTION_MIN_SEEDERS ili MIN_SEEDERS.

Elementum prikazuje samo 4K (bez 1080p)

Uzrok: RESERVED_LOWER_SLOTS_PCT je prenizak ili je 0.

Rješenje: Postavi na 50 (default) ili 67 za više nižih rezolucija.
Elementum prikazuje samo 1080p (bez 4K)

Uzrok: RESERVED_LOWER_SLOTS_PCT je previsok (npr. 100).

Rješenje: Smanji na 50 ili 33.
Magnet se ne resolva (torrent ne kreće)

Provjeri log:
bash

docker logs prowlarr-torznab-bridge | grep "resolve"

Mogući uzroci:

    Prowlarr vraća redirect na stranicu (ne na magnet) — normalno, bridge vraća 302 Elementumu

    Infohash nije u metapodacima — torrent bez infohasha se ne može pretvoriti u magnet

Elementum prikazuje "Pack" za cijelu sezonu

Uzrok: Season-pack filter još nije implementiran (planirano za v2.7.2).

Workaround: Ručno provjeri veličinu u Elementum UI-u prije klika — ako je >5 GB za epizodu, vjerojatno je pack.
Tailscale efemerni čvor se briše

Problem: Ako je Tailscale auth key kreiran s opcijom "Ephemeral", čvor se automatski briše nakon 30-60 min neaktivnosti.

Rješenje:

    Obriši efemerni čvor u admin konzoli

    Kreiraj novi auth key bez "Ephemeral" opcije

    Postavi trajnu pohranu u Docker:
    yaml

    volumes:
      - ./tailscale-state:/var/lib/tailscale

    Restart container

Kako uključiti debug logove

Postavi DEBUG=1 u env, restart, i:
bash

docker logs -f prowlarr-torznab-bridge

Vidjet ćeš:

    [tier] — koliko kandidata po tieru

    [tier-filter] — finalni broj

    [prefetch] — magnet resolution

    [resolve] — redirect chain

    [stremio] — StremioArrs rezultati

    [merge] — Prowlarr + StremioArrs merge

Kako testirati bez Elementuma
bash

# TV search
curl -s "http://localhost:9117/api?t=tvsearch&q=mobland&season=2&ep=4&apikey=YOUR_FAKE_KEY" | head -30

# Movie search
curl -s "http://localhost:9117/api?t=movie&q=inception&apikey=YOUR_FAKE_KEY" | head -30

# Health
curl -s "http://localhost:9117/health" | python3 -m json.tool

text


**Commit changes** → "Add troubleshooting docs"
