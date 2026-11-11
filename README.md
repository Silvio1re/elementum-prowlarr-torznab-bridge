# Prowlarr Torznab Bridge

Torznab proxy koji spaja **Prowlarr** s **Elementum** (Kodi) i dodaje napredni **tiered filter rezolucija** (4K → 1080p → 720p) s kontrolom veličine i broja seedera.

## Zašto?

Elementum native Jackett integracija ne podržava:
- Prioritet rezolucija (4K prvo, pa 1080p, pa 720p)
- Limit veličine po rezoluciji (npr. max 25 GB za 4K)
- Rezervaciju slotova za niže rezolucije

Ovaj bridge to rješava.

## Značajke

- ✅ **Tiered filter**: 4K → 1080p → 720p s min-seederima po tieru
- ✅ **4K cap + reserved slots**: npr. 15× 4K + 15× 1080p (umjesto 30× 4K)
- ✅ **Max veličina 4K**: filtrira remuxove >25 GB
- ✅ **Multi-source**: Prowlarr + StremioArrs
- ✅ **Magnet resolution**: automatski pretvara .torrent redirect u magnet
- ✅ **TV episode filter**: SxxExx strict matching
- ✅ **Health endpoint**: `/health` za monitoring

## Brzi start

```yaml
# docker-compose.yml
services:
  prowlarr-torznab-bridge:
    image: ghcr.io/Silvio1re/prowlarr-torznab-bridge:latest
    ports:
      - "9117:9117"
    environment:
      - PROWLARR_URL=http://prowlarr:9696
      - PROWLARR_API_KEY=${PROWLARR_API_KEY}
      - FAKE_API_KEY=change_me
    restart: unless-stopped
