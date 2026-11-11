# Changelog

## [2.7.1] - 2026-11-09

### Added
- `RESERVED_LOWER_SLOTS_PCT` env varijabla (default: 50)
- 4K cap + rezervirani slotovi za niže rezolucije + spillover
- Health endpoint prikazuje `reservedLowerSlotsPct`

### Changed
- Tiered filter sada ograničava 4K na `maxResults - reservedSlots`
- Niži tieri (1080p, 720p) dobivaju rezervirane slotove

### Fixed
- MobLand S02E04 vraća 15× 4K + 15× 1080p (umjesto 30× 4K)

## [2.7.0] - 2026-11-09

### Added
- Tiered filter: 4K → 1080p → 720p s prioritetom
- Fill to MAX ponašanje (uvijek puna lista do `MAX_RESULTS`)
- Min seeders po tieru (`RESOLUTION_MIN_SEEDERS`)
- Max veličina za 4K tier (`MAX_SIZE_4K_GB`)

### Changed
- Sortiranje: po rezoluciji, unutar tiera po seederima

## [2.6.4] - 2026-11-08

### Fixed
- Magnet/torrent/redirect resolve za Docker interne redirecte
- Eksterni redirect se sada prosljeđuje Elementumu kao 302

## [2.6.0] - 2026-11-07

### Added
- StremioArrs integracija za TV search
- Torznab XML parser za StremioArrs rezultate
- Merge s dedupe po infohash
