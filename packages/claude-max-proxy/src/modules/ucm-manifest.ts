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
const UCM_MANIFEST_REV = 1

export const CONTROL_MANIFEST_URI = 'ui://control-manifest'

export function buildControlManifest(proxyVersion: string): UcmManifest {
  const manifest = {
    ucm: '1.0',
    version: `${proxyVersion}+ucm${UCM_MANIFEST_REV}`,
    service: {
      id: 'claude-max-proxy',
      name: 'Claude Max Proxy',
      auth: { type: 'bearer', scopeHint: 'control' },
    },
    transport: { type: 'mcp-streamable-http', endpoint: '/mcp' },
    layout: [
      { type: 'group', title: 'Organizations', controls: ['orgs_list', 'org_switch'] },
      {
        type: 'group',
        title: 'Keepalive',
        controls: ['ka_indicator', 'sessions_reload', 'sessions_disarm'],
      },
      { type: 'group', title: 'Health', controls: ['health_indicator', 'proxy_status'] },
    ],
    controls: [
      {
        id: 'orgs_list',
        kind: 'list',
        title: 'Organizations',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        binding: { type: 'tool', op: 'orgs_list' },
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
      },
      {
        id: 'health_indicator',
        kind: 'indicator',
        title: 'Heartbeat',
        schema: { type: 'object' },
        binding: { type: 'event', op: 'stream', match: { kind: 'HEALTH_HEARTBEAT' } },
      },
      {
        id: 'proxy_status',
        kind: 'button',
        title: 'Proxy status',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        binding: { type: 'tool', op: 'proxy_status' },
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
