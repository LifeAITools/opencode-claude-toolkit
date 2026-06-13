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
 */
import { validateManifest, type UcmManifest } from '@kiberos/ucm-schema'

/** Ревизия маппинга: bump при любом изменении контролов ниже. */
const UCM_MANIFEST_REV = 7

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

export const CONTROL_MANIFEST_URI = 'ui://control-manifest'

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
    // layout-дерево UCM 1.2: парные действия/индикаторы объединены в card
    // (одна карточка, контролы без собственных рамок)
    layout: [
      { type: 'group', title: 'Organizations', controls: ['orgs_list', 'org_switch'] },
      {
        type: 'group',
        title: 'Keepalive',
        controls: ['ka_indicator', 'ka_chart'],
        children: [
          { type: 'card', title: 'KA actions', controls: ['sessions_reload', 'sessions_disarm'] },
        ],
      },
      {
        type: 'group',
        title: 'Health',
        controls: ['ka_level'],
        children: [
          { type: 'card', title: 'Heartbeat & status', controls: ['health_indicator', 'proxy_status'] },
          { type: 'card', title: 'Live metrics', controls: ['sessions_value', 'heartbeat_kv'] },
        ],
      },
    ],
    controls: [
      {
        id: 'orgs_list',
        kind: 'list',
        title: 'Organizations',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        binding: { type: 'tool', op: 'orgs_list' },
        // человеческие строки вместо сырого JSON: items указывает на /orgs,
        // itemLabel — шаблон строки (рендерит пульт, UCM 1.1 uiHints)
        uiHints: { items: '/orgs', itemLabel: '{/orgName} — {/orgId}' },
      },
      {
        id: 'org_switch',
        kind: 'select',
        title: 'Switch session org',
        schema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', title: 'Session UUID' },
            org: { type: 'string', title: 'Org (UUID / prefix / name)' },
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
            label: '{/orgName} ({/orgId})',
          },
        },
      },
      {
        id: 'ka_indicator',
        kind: 'indicator',
        title: 'KA ticks',
        schema: { type: 'object' },
        uiHints: { widget: 'sparkline' },
        binding: { type: 'event', op: 'stream', match: { kind: 'PROXY_KA_TICK' } },
      },
      {
        // Φ7 chart на РЕАЛЬНЫХ KA-данных: история тиков → area-график (ECharts).
        // Анимация — motion-токенами пульта. Демонстрирует богатую палитру на проде.
        id: 'ka_chart',
        kind: 'chart',
        title: 'KA activity',
        schema: { type: 'object' },
        uiHints: { chartType: 'area' },
        binding: { type: 'event', op: 'stream', match: { kind: 'PROXY_KA_TICK' } },
      },
      {
        id: 'sessions_reload',
        kind: 'button',
        title: 'Reload sessions',
        schema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', title: 'Session (empty = all)' },
            reason: { type: 'string', title: 'Reason' },
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
            session_id: { type: 'string', title: 'Session (empty = all)' },
            reason: { type: 'string', title: 'Reason' },
          },
        },
        binding: { type: 'tool', op: 'sessions_disarm' },
        optionsSources: { session_id: SESSION_OPTIONS },
      },
      {
        id: 'health_indicator',
        kind: 'indicator',
        title: 'Heartbeat',
        schema: { type: 'object' },
        // valueLabel: пульт показывает строку вместо сырого JSON heartbeat'а
        uiHints: { valueLabel: '{/sessions} sessions · {/liveKa} live KA · {/firesLastHour} fires/h' },
        binding: { type: 'event', op: 'stream', match: { kind: 'HEALTH_HEARTBEAT' } },
      },
      {
        id: 'proxy_status',
        kind: 'button',
        title: 'Proxy status',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        binding: { type: 'tool', op: 'proxy_status' },
      },
      // --- богатая палитра на живых метриках (словарь 1.5) ---
      {
        id: 'sessions_value',
        kind: 'value',
        title: 'Active sessions',
        schema: { type: 'object' },
        uiHints: { valueLabel: '{/sessions}', unit: 'live' },
        binding: { type: 'event', op: 'stream', match: { kind: 'HEALTH_HEARTBEAT' } },
      },
      {
        id: 'heartbeat_kv',
        kind: 'kv-table',
        title: 'Heartbeat detail',
        schema: { type: 'object' },
        uiHints: { keys: ['sessions', 'liveKa', 'firesLastHour'] },
        binding: { type: 'event', op: 'stream', match: { kind: 'HEALTH_HEARTBEAT' } },
      },
      {
        id: 'ka_level',
        kind: 'led-bar',
        title: 'KA activity',
        schema: { type: 'number', minimum: 0, maximum: 20 },
        uiHints: { count: 20, warn: 0.7, err: 0.9 },
        binding: { type: 'event', op: 'stream', match: { kind: 'PROXY_KA_TICK' } },
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
