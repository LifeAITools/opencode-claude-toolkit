/**
 * Промежуток между служебными запросами следует за СРОКОМ, а не за минутами.
 *
 * 🔴 РЕШЕНИЕ ФАУНДЕРА 04.09.2026, его словами: «30 или 45 — это всего лишь
 * влияет на то, как быстро мы постараемся отправить... это может быть 75%, 50%
 * или 80%». Абсолютное число живёт правильно ровно до первой смены срока:
 * пометки в запросах бывают и часовые, и пятиминутные, а сорок пять минут
 * остаются сорока пятью минутами и превращаются в опоздание на сорок.
 *
 * Доля 0.75 подобрана так, чтобы СЕГОДНЯ не изменилось ничего: при часовом
 * кэше это ровно те же сорок пять минут, что стояли в настройке руками.
 */

import { describe, test, expect, afterAll } from 'bun:test'
import { writeFileSync, readFileSync } from 'fs'
import { reloadKeepaliveConfig, loadKeepaliveConfig } from '../src/keepalive-config.js'

// 🔴 ПУТЬ К НАСТРОЙКАМ ФИКСИРУЕТСЯ ПРИ ЗАГРУЗКЕ МОДУЛЯ, а не при каждом чтении:
// подменить переменную окружения ПОСЛЕ импорта нельзя, и попытка это сделать
// молча читает совсем другой файл — первый черновик этого набора так и получил
// минимальный промежуток вместо сорока пяти минут по всем шести проверкам.
// Поэтому пишем в тот самый файл, который набор уже открыл, и возвращаем его
// содержимое в конце.
const FIXTURE = process.env.CLAUDE_KEEPALIVE_CONFIG_PATH!
const SAVED = readFileSync(FIXTURE, 'utf8')

function withConfig(cfg: Record<string, unknown>) {
  writeFileSync(FIXTURE, JSON.stringify(cfg))
  reloadKeepaliveConfig()
  return loadKeepaliveConfig()
}

afterAll(() => {
  writeFileSync(FIXTURE, SAVED)
  reloadKeepaliveConfig()
})

describe('промежуток — доля срока, а не вбитое число', () => {
  test('часовой кэш даёт те же 45 минут, что стояли руками — сегодня не меняется ничего', () => {
    const c = withConfig({ cacheTtlSec: 3600, safetyMarginSec: 60 })
    expect(c.intervalMs).toBe(45 * 60_000)
  })

  test('пятиминутный кэш ужимает промежуток сам — вот ради чего всё', () => {
    const c = withConfig({ cacheTtlSec: 300, safetyMarginSec: 60 })
    // 0.75 от пяти минут = 3 мин 45 с, но потолок (срок − запас − минута) режет
    // до трёх минут: последний выстрел обязан успеть завершиться.
    expect(c.intervalMs).toBe(3 * 60_000)
    expect(c.intervalMs).toBeLessThan(300_000)
  })

  test('двухчасовой кэш больше не упирается в получасовой потолок прежней формулы', () => {
    // Прежняя формула (половина срока, но не больше 30 мин) давала 30 минут и
    // при часе, и при двух часах — то есть переставала следовать за сроком
    // ровно там, где это дороже всего.
    const c = withConfig({ cacheTtlSec: 7200, safetyMarginSec: 60 })
    expect(c.intervalMs).toBe(90 * 60_000)
  })

  test('явно заданные минуты по-прежнему сильнее доли — старые настройки не ломаются', () => {
    const c = withConfig({ cacheTtlSec: 3600, safetyMarginSec: 60, intervalSec: 600 })
    expect(c.intervalMs).toBe(600_000)
  })

  test('долю можно поменять в настройке, и она пересчитывает промежуток', () => {
    const c = withConfig({ cacheTtlSec: 3600, safetyMarginSec: 60, intervalFraction: 0.5 })
    expect(c.intervalMs).toBe(30 * 60_000)
  })

  test('нелепая доля зажимается к ближайшей допустимой, а не превращает промежуток в ноль', () => {
    // Ноль зажимается к 0.1 — шесть минут при часовом кэше. Ошибаться в эту
    // сторону безопасно: лишний служебный выстрел по живому кэшу стоит дешёвого
    // чтения, а слишком редкий — полной перепокупки разговора.
    const c = withConfig({ cacheTtlSec: 3600, safetyMarginSec: 60, intervalFraction: 0 })
    expect(c.intervalMs).toBe(6 * 60_000)
  })

  test('и в другую сторону: доля 5 не даст ждать дольше самого срока', () => {
    const c = withConfig({ cacheTtlSec: 3600, safetyMarginSec: 60, intervalFraction: 5 })
    expect(c.intervalMs).toBeLessThan(3600_000)
  })
})
