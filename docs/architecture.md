Arhitektura
Dijagram toka
text

┌─────────┐    ┌──────────┐    ┌─────────────┐    ┌──────────┐
│  Kodi   │───▶│ Elementum│───▶│  Torznab    │───▶│ Prowlarr │
│  (UI)   │    │ (daemon) │    │  Bridge     │    │          │
└─────────┘    └──────────┘    │  (v2.7.1)   │    └──────────┘
                               │             │
                               │  Tiered     │    ┌──────────┐
                               │  filter     │───▶│StremioArrs│
                               │             │    └──────────┘
                               └─────────────┘

Komponente
1. Kodi (klijent)

    Prikazuje Elementum UI

    Šalje zahtjeve Elementum daemonu

2. Elementum daemon

    Prima zahtjeve od Koda

    Upravlja torrentima (add, play, pause, delete)

    Pita Torznab Bridge za rezultate pretrage

    Streama torrent Kodi playeru

3. Torznab Bridge (ovaj projekt)

    Prima Torznab API zahtjeve od Elementuma

    Pretvara ih u Prowlarr search

    Opcionalno spaja s StremioArrs

    Primjenjuje filtere:

        Global min seeders

        Exclude bad resolution (cam, ts, 480p)

        TV episode filter (SxxExx)

        Tiered filter (4K → 1080p → 720p)

        Limit na MAX_RESULTS

    Prefetch magnet resolution

    Vraća Torznab XML Elementumu

4. Prowlarr

    Agregira N indexera (1337x, RARBG, YTS, itd.)

    Vraća JSON s torrent rezultatima

5. StremioArrs (opcionalno)

    Dodatni izvor rezultata

    Vraća Torznab XML

Tiered filter — detaljno
Ulaz

Lista releasea iz Prowlarr/StremioArrs (može biti 50-200 rezultata).
Faza 1 — Razvrstavanje po tieru

Za svaki tier (4k, 1080p, 720p):

    Filtriraj po regexu (2160p/4k/uhd, 1080p, 720p)

    Filtriraj po min seederima

    Filtriraj po max veličini (samo 4K tier)

    Sortiraj po seederima (desc)

Rezultat: 3 bucketa, svaki sortiran po seederima.
Faza 2 — Dodjela slotova
text

reservedSlots = floor(maxResults × RESERVED_LOWER_SLOTS_PCT / 100)
maxTopSlots = maxResults - reservedSlots

# 4K dobiva do maxTopSlots
used[0] = min(4K_bucket.length, maxTopSlots)

# Niži tieri pune reservedSlots
lowerUsed = 0
for i in 1..n:
  canAdd = min(bucket[i].length, reservedSlots - lowerUsed)
  used[i] = canAdd
  lowerUsed += canAdd

Faza 3 — Spillover

Ako niži tieri nisu popunili sve reservedSlots, 4K dobiva preostale slotove.
Faza 4 — Složi rezultat

Redom: 4K → 1080p → 720p, svaki tier do used[i] mjesta.
Primjer (MobLand S02E04, MAX=30, PCT=50)
Tier	Kandidata	Reserved	Dodano
4K	51	—	15 (cap)
1080p	30	15	15
720p	5	15	0 (1080p popunio)
Ukupno			30
Magnet resolution

Prowlarr vraća .torrent fajlove ili redirect URL-ove, ne magnete. Bridge:

    Prima downloadUrl od Prowlarr

    Slijedi redirect chain (max 8 hopova)

    Ako naiđe na magnet: → vraća magnet

    Ako naiđe na .torrent fajl → kešira buffer

    Ako naiđe na eksterni redirect (npr. na 1337x.to) → vraća 302 Elementumu

Prefetch

Prije slanja XML-a, bridge prefetcha magnete za sve iteme koji nemaju infoHash ni magnetUrl (max 30s timeout). To ubrzava prvi klik u Elementumu (magnet je već pripremljen).
Filter pipeline — redoslijed

Svaki zahtjev prolazi kroz sljedeće faze:

    Prowlarr + StremioArrs → paralelno (Promise.all)

    Merge → spoji rezultate

    Dedupe → po infohash/magnet/guid/title

    Global min seeders → filter po MIN_SEEDERS

    Bad resolution → exclude cam, ts, 480p, itd.

    TV episode filter → SxxExx strict matching (samo za tvsearch)

    Tiered filter → 4K cap + reserved lower slots + spillover

    Prefetch → magnet resolution za iteme bez infohasha

    XML output → Torznab RSS

Error handling

    Prowlarr padne → vraća praznu listu (StremioArrs može spasiti)

    StremioArrs padne → nastavlja s Prowlarr rezultatima

    Oba padnu → prazna lista (200 OK, ne 5xx)

    Magnet resolution fail → item ostaje s proxy_download linkom

Performanse

    Prowlarr timeout: 30s

    StremioArrs timeout: 20s

    Prefetch timeout: 30s

    Magnet cache: in-memory Map (perzistira dok container radi)

    Batch size za prefetch: 5 paralelno

Vidi također

    configuration.md — sve env varijable

    troubleshooting.md — poznati problemi
