# Konfiguracija

Sve opcije se postavljaju kroz **environment varijable**.

## Obavezne

| Varijabla | Default | Opis |
|---|---|---|
| `PROWLARR_URL` | `http://127.0.0.1:9696` | URL Prowlarr instance |
| `PROWLARR_API_KEY` | *(prazno)* | Prowlarr API ključ (Settings → General → API Key) |
| `FAKE_API_KEY` | `prowlarr-proxy` | Ključ koji Elementum koristi za pristup proxyju |

## Tiered filter

| Varijabla | Default | Opis |
|---|---|---|
| `RESOLUTION_PRIORITY` | `4k,1080p,720p` | Redoslijed rezolucija. `none` = isključi filter |
| `RESOLUTION_MIN_SEEDERS` | `5,3,1` | Min seedera po tieru (mora odgovarati broju tierova) |
| `MAX_SIZE_4K_GB` | `25` | Max veličina za 4K tier (GB) |
| `RESERVED_LOWER_SLOTS_PCT` | `50` | % slotova rezerviranih za niže tiere (0-100) |
| `MIN_SEEDERS` | `1` | Globalni minimum seedera (prije tiered filtera) |

### Primjeri

**Više 4K, manje nižih (67% 4K):**
```bash
RESERVED_LOWER_SLOTS_PCT=33
