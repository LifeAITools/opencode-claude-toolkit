/**
 * ucm-manifest.ts — UCM (Universal Control Manifest) поверх существующего
 * MCP control surface (UCB S5-T1, REQ-15).
 *
 * Декларация пульта для Universal Control Board: маппинг наших tools в
 * примитивы словаря UCM + live-индикаторы из GET /mcp стрима. Контракт —
 * @kiberos/ucm-schema (SSOT, npm.muid.io); манифест валидируется на старте
 * модуля: прокси не имеет права эмитить невалидный контракт.
 *
 * Версия инстанса (`version`) — ключ кэша пультов: меняется с версией прокси
 * и ревизией маппинга (UCM_MANIFEST_REV) — любое изменение инвалидирует кэш.
 *
 * REV 8 — композиция дашборда (правильное использование примитивов/layout):
 *  - KPI-полоска (toolbar) из value-стат поверх HEALTH_HEARTBEAT (valueLabel
 *    извлекает поле объекта; число извлекается строковым шаблоном, НЕ метром);
 *  - Keepalive (split): chart+led-bar на СКАЛЯРНОМ PROXY_KA_TICK (числовые
 *    метры выбирают первое число — корректны только на скалярном событии),
 *    рядом kv-table телеметрии;
 *  - Действия (card): reload/disarm/status в одной панели, без sprawl;
 *  - Орг и сессии (split): org_switch + чистый список орг и список сессий.
 */
import { validateManifest, type UcmManifest } from '@kiberos/ucm-schema'

/** Ревизия маппинга: bump при любом изменении контролов ниже. */
const UCM_MANIFEST_REV = 8

/**
 * Динамические опции "выбор сессии" (UCM 1.1 optionsSources): пульт зовёт
 * sessions_list и показывает display (cwd · model — "кто есть кто"), отправляя
 * sessionId. refreshMs держит список живым (сессии приходят/уходят).
 */
const SESSION_OPTIONS = {
  binding: { type: 'tool', op: 'sessions_list' },
  value: '/sessionId',
  label: '{/display}',
  refreshMs: 30_000,
}

/** Биндинг к heartbeat-стриму (объект телеметрии, обновляется раз в N сек). */
const HEARTBEAT = { type: 'event', op: 'stream', match: { kind: 'HEALTH_HEARTBEAT' } }
/** Биндинг к скалярному KA-тику (одно число — годен для числовых метров/графиков). */
const KA_TICK = { type: 'event', op: 'stream', match: { kind: 'PROXY_KA_TICK' } }

export const CONTROL_MANIFEST_URI = 'ui://control-manifest'

/**
 * KPI-стат поверх HEALTH_HEARTBEAT: `value` извлекает поле объекта строковым
 * шаблоном valueLabel ({/field}) — это единственный корректный способ достать
 * конкретное поле из объектного события (числовые метры берут первое число).
 */
function kpi(id: string, title: string, field: string, unit: string) {
  return {
    id,
    kind: 'value',
    title,
    schema: { type: 'object' },
    uiHints: { valueLabel: `{${field}}`, unit },
    binding: HEARTBEAT,
  }
}

export function buildControlManifest(proxyVersion: string): UcmManifest {
  const manifest = {
    ucm: '1.2',
    version: `${proxyVersion}+ucm${UCM_MANIFEST_REV}`,
    service: {
      id: 'claude-max-proxy',
      name: 'Claude Max Proxy',
      auth: { type: 'bearer', scopeHint: 'control' },
    },
    transport: { type: 'mcp-streamable-http', endpoint: '/mcp' },
    // Композиция дашборда: KPI-полоска → keepalive (split) → действия (card)
    // → орг/сессии (split). toolbar=ряд, card=одна панель, split=2 колонки.
    layout: [
      {
        type: 'toolbar',
        title: 'Обзор',
        controls: ['kpi_sessions', 'kpi_liveka', 'kpi_fires', 'kpi_ticks', 'kpi_util5h', 'kpi_util7d'],
      },
      {
        type: 'split',
        title: 'Keepalive',
        uiHints: { ratio: 0.6 },
        controls: [],
        children: [
          { type: 'card', title: 'Активность KA', controls: ['ka_chart', 'ka_level'] },
          { type: 'card', title: 'Телеметрия', controls: ['heartbeat_kv'] },
        ],
      },
      {
        type: 'card',
        title: 'Действия с сессиями',
        controls: ['sessions_reload', 'sessions_disarm', 'proxy_status'],
      },
      {
        type: 'split',
        title: 'Организации и сессии',
        uiHints: { ratio: 0.5 },
        controls: [],
        children: [
          { type: 'card', title: 'Организации', controls: ['org_switch', 'orgs_list'] },
          { type: 'card', title: 'Отслеживаемые сессии', controls: ['sessions_list_view'] },
        ],
      },
    ],
    controls: [
      // --- KPI-полоска (value-стат поверх HEALTH_HEARTBEAT, valueLabel-поле) ---
      kpi('kpi_sessions', 'Сессии', '/sessions', 'активных'),
      kpi('kpi_liveka', 'Live KA', '/liveKa', 'держим'),
      kpi('kpi_fires', 'Срабатываний', '/firesLastHour', 'за час'),
      kpi('kpi_ticks', 'Тиков', '/ticksLastHour', 'за час'),
      kpi('kpi_util5h', 'Квота 5ч', '/util5h', 'util'),
      kpi('kpi_util7d', 'Квота 7д', '/util7d', 'util'),

      // --- Keepalive: числовые виджеты на СКАЛЯРНОМ PROXY_KA_TICK ---
      {
        // Φ7 chart на реальных KA-данных: история тиков → area-график (ECharts).
        id: 'ka_chart',
        kind: 'chart',
        title: 'Активность KA',
        schema: { type: 'object' },
        uiHints: { chartType: 'area', height: 180, unit: 'тик' },
        binding: KA_TICK,
      },
      {
        id: 'ka_level',
        kind: 'led-bar',
        title: 'Уровень KA',
        schema: { type: 'number', minimum: 0, maximum: 20 },
        uiHints: { count: 20, warn: 0.7, err: 0.9 },
        binding: KA_TICK,
      },
      {
        id: 'heartbeat_kv',
        kind: 'kv-table',
        title: 'Телеметрия',
        schema: { type: 'object' },
        uiHints: {
          keys: ['sessions', 'liveKa', 'firesLastHour', 'ticksLastHour', 'avgCacheRead', 'zeroCacheWrites', 'util5h', 'util7d'],
        },
        binding: HEARTBEAT,
      },

      // --- Действия с сессиями (одна панель) ---
      {
        id: 'sessions_reload',
        kind: 'button',
        title: 'Reload sessions',
        schema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', title: 'Сессия (пусто = все)' },
            reason: { type: 'string', title: 'Причина' },
          },
        },
        binding: { type: 'tool', op: 'sessions_reload' },
        optionsSources: { session_id: SESSION_OPTIONS },
      },
      {
        id: 'sessions_disarm',
        kind: 'button',
        title: 'Disarm KA',
        dangerous: true,
        schema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', title: 'Сессия (пусто = все)' },
            reason: { type: 'string', title: 'Причина' },
          },
        },
        binding: { type: 'tool', op: 'sessions_disarm' },
        optionsSources: { session_id: SESSION_OPTIONS },
      },
      {
        id: 'proxy_status',
        kind: 'button',
        title: 'Proxy status',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        binding: { type: 'tool', op: 'proxy_status' },
      },

      // --- Организации и сессии ---
      {
        id: 'org_switch',
        kind: 'select',
        title: 'Переключить орг сессии',
        schema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', title: 'Сессия' },
            org: { type: 'string', title: 'Орг (UUID / префикс / имя)' },
          },
          required: ['session_id', 'org'],
        },
        uiHints: { icon: 'swap' },
        binding: { type: 'tool', op: 'org_switch' },
        optionsSources: {
          session_id: SESSION_OPTIONS,
          org: {
            binding: { type: 'tool', op: 'orgs_list' },
            items: '/orgs',
            value: '/orgId',
            label: '{/orgName}',
          },
        },
      },
      {
        id: 'orgs_list',
        kind: 'list',
        title: 'Организации',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        binding: { type: 'tool', op: 'orgs_list' },
        uiHints: { items: '/orgs', itemLabel: '{/orgName}' },
      },
      {
        id: 'sessions_list_view',
        kind: 'list',
        title: 'Отслеживаемые сессии',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        binding: { type: 'tool', op: 'sessions_list' },
        uiHints: { itemLabel: '{/display}' },
      },
    ],
    apps: [],
    availability: { stream: '/mcp', snapshotKind: 'CONTROL_SNAPSHOT' },
  }

  const result = validateManifest(manifest)
  if (!result.ok) {
    throw new Error(`UCM manifest invalid: ${result.errors.join('; ')}`)
  }
  if (result.warnings.length > 0) {
    throw new Error(
      `UCM manifest must be pristine, got warnings: ${result.warnings.map((w) => `${w.code}@${w.path}`).join(', ')}`,
    )
  }
  return result.manifest
}
