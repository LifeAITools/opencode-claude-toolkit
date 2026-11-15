/**
 * Управляющая плоскость закрыта для чужих.
 *
 * 🔴 Повод — находка владельца SynqTask 15.11.2026: дверь слушает 0.0.0.0 (попутный /v1 нужен
 * боковым контейнерам), и вместе с ним с ЛЮБОГО интерфейса машины читались /admin/sessions,
 * а вместе с ними и записывающие ручки: /admin/shutdown, /admin/cache-rewrite-ok (согласие на
 * дорогую запись), /admin/disarm, /admin/quota-ok. Модуль контроля существовал и НЕ БЫЛ
 * ПОДКЛЮЧЁН — охрана стояла написанной и не работала. Эти испытания держат три обещания:
 *  (а) свои процессы (loopback) работают без настройки;
 *  (б) чужой без токена получает 401;
 *  (в) без настроенного токена удалённый доступ запрещён ВОВСЕ (fail-closed), а не открыт.
 */
import { describe, expect, test } from 'bun:test'
import { isLoopback, requireControlAuth } from './control-auth.js'

const req = (auth?: string) => new Request('http://127.0.0.1:5050/admin/sessions', auth ? { headers: { authorization: auth } } : undefined)
const from = (address: string) => ({ requestIP: () => ({ address }) }) as never

describe('control-auth', () => {
  test('loopback считается своим: 127.0.0.1, ::1, ::ffff:127.0.0.1', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopback(req(), from(ip))).toBe(true)
    }
  })
  test('чужой адрес — не свой, даже если очень близкий', () => {
    for (const ip of ['127.0.0.2', '192.168.1.5', '172.17.0.1', '']) {
      expect(isLoopback(req(), from(ip))).toBe(false)
    }
  })
  test('свой процесс проходит без токена', () => {
    expect(requireControlAuth(req(), from('127.0.0.1'), null)).toBeNull()
  })
  test('чужой без токена — 401', () => {
    const r = requireControlAuth(req(), from('192.168.1.5'), 'secret-token')
    expect(r?.status).toBe(401)
  })
  test('чужой с верным токеном проходит', () => {
    expect(requireControlAuth(req('Bearer secret-token'), from('192.168.1.5'), 'secret-token')).toBeNull()
  })
  test('токен не настроен — удалённый доступ запрещён ВОВСЕ (fail-closed)', () => {
    const r = requireControlAuth(req('Bearer anything'), from('192.168.1.5'), null)
    expect(r?.status).toBe(401)
  })
  test('неверный токен не проходит', () => {
    const r = requireControlAuth(req('Bearer wrong'), from('192.168.1.5'), 'secret-token')
    expect(r?.status).toBe(401)
  })
})
