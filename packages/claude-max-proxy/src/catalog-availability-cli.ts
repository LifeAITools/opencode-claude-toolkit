/**
 * Один ход донесения доступности — для systemd-таймера, а НЕ для процесса прокси.
 *
 * 🔴 ПОЧЕМУ ОТДЕЛЬНАЯ ДВЕРЬ, А НЕ ТАЙМЕР ВНУТРИ ПРОКСИ (26.10.2026). Модуль живёт в пакете
 * прокси, но включение его изнутри требует перезапуска службы — то есть ради отчёта о
 * доступности задевается трафик всего флота. Одноразовый ход раз в пять минут делает то же
 * самое, ничего не трогая, и его отказ не имеет права задеть прокси: у него свой юнит.
 *
 * Выключено по умолчанию (`CATALOG_AVAILABILITY_ENABLED`): без флага — ни запроса, ни записи.
 */
import { readCatalogAvailabilityConfig, sendAvailability } from './catalog-availability.js'

if (import.meta.main) {
  const cfg = readCatalogAvailabilityConfig(process.env)
  const out = await sendAvailability(cfg, { log: (line) => console.info(line) })
  // Одна строка на ход: машина, сколько моделей, код двери или причина отказа. Значений
  // секретов здесь нет и быть не может — их не возвращает sendAvailability.
  console.info(
    out.sent
      ? `CATALOG_AVAILABILITY sent machine=${cfg.machine} models=${out.models} status=${out.status}`
      : `CATALOG_AVAILABILITY skipped machine=${cfg.machine} reason=${out.reason}`,
  )
}
