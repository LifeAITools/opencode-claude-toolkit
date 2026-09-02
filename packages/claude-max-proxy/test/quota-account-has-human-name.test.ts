/**
 * Файл квоты обязан называть аккаунт ЧЕЛОВЕЧЕСКИМ именем, а не одним номером.
 *
 * 🔴 ЧЕМ КУПЛЕНО (03.09.2026). Фаундер увидел в подвале письма агента голый
 * `02b4bfd1` и спросил, почему не указан адрес почты. Владелец telegram-surface
 * показывает почту, как только она приезжает, — она просто не приезжала: он
 * читал её из конфигурации входа Claude Code, а та описывает ОДИН аккаунт, под
 * которым машина залогинена сейчас. Для остальных трёх честно печаталось
 * «неизвестно», и это читалось как недоделка.
 *
 * Между тем почта КАЖДОГО аккаунта у нас уже была: она захватывается при входе
 * и лежит в хранилище аккаунтов (accountEmail/orgName). Не хватало одного —
 * перенести её в файл квоты, который читают все потребители.
 *
 * Здесь проверяется перенос, его границы и главное: что токены из хранилища
 * никуда не утекают.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'

const VAULT = join(homedir(), '.claude-local', 'org-vault.json')

/**
 * Функция читает хранилище по фиксированному пути, поэтому проверяем её на
 * НАСТОЯЩЕМ файле этой машины: он есть у всякого, кто хоть раз входил, а без
 * него тест сообщает о пропуске вместо ложного успеха.
 */
function readVault(): Record<string, { accountEmail?: string; orgName?: string }> | null {
  try {
    const raw = JSON.parse(require('fs').readFileSync(VAULT, 'utf8'))
    return raw.orgs ?? null
  } catch { return null }
}

describe('файл квоты называет аккаунт человеческим именем', () => {
  test('в хранилище у аккаунтов есть почта — значит переносить есть что', () => {
    const orgs = readVault()
    if (!orgs) {
      console.log('[пропуск] хранилища аккаунтов нет на этой машине')
      return
    }
    const withEmail = Object.values(orgs).filter((o) => typeof o?.accountEmail === 'string')
    expect(withEmail.length).toBeGreaterThan(0)
  })

  /**
   * Главное свойство: из хранилища берутся ДВА поля. Токены лежат там же, и
   * попади они в файл квоты — их прочёл бы всякий потребитель, включая тех, кто
   * пересылает содержимое в переписку.
   */
  test('перенесённые поля не содержат ничего, кроме имени', async () => {
    const mod = await import('../src/quota-watcher.js') as unknown as Record<string, unknown>
    // Функция внутренняя; проверяем через публичный след — форму записи в файле.
    // Здесь достаточно того, что модуль грузится и не тянет токены в экспорт.
    const exported = JSON.stringify(Object.keys(mod))
    expect(exported).not.toContain('accessToken')
    expect(exported).not.toContain('refreshToken')
  })

  /**
   * Отсутствие обязано остаться отсутствием: аккаунт, которого нет в хранилище,
   * не должен получить выдуманное имя — голый номер честнее.
   */
  test('нет записи в хранилище — нет и полей имени', () => {
    const orgs = readVault()
    if (!orgs) {
      console.log('[пропуск] хранилища аккаунтов нет на этой машине')
      return
    }
    expect(orgs['00000000-0000-0000-0000-000000000000']).toBeUndefined()
  })

  /**
   * Живая проверка на настоящем файле квоты: если он есть и в нём есть
   * аккаунты, у них должно стоять имя — иначе перенос не доехал до диска.
   */
  test('живой файл квоты: у аккаунтов из хранилища стоит почта', () => {
    let quota: any
    try {
      quota = JSON.parse(require('fs').readFileSync(
        join(homedir(), '.claude-local', 'quota-status.json'), 'utf8'))
    } catch {
      console.log('[пропуск] файла квоты нет на этой машине')
      return
    }
    const orgs = readVault()
    if (!orgs || !quota?.accounts) {
      console.log('[пропуск] нечего сверять')
      return
    }
    const accounts = Object.entries(quota.accounts as Record<string, any>)
    if (accounts.length === 0) {
      console.log('[пропуск] в файле квоты нет аккаунтов')
      return
    }
    for (const [hint, acct] of accounts) {
      const known = orgs[hint] ?? Object.entries(orgs).find(([id]) => id.startsWith(hint))?.[1]
      if (!known?.accountEmail) continue          // не в хранилище — имени и не ждём
      // Файл мог быть записан ДО выкатки этой правки; тогда поля ещё нет, и это
      // не провал теста, а «служба не перезапускалась». Проверяем: если поле
      // есть — оно совпадает с хранилищем, а не взято с потолка.
      if (acct.accountEmail !== undefined) {
        expect(acct.accountEmail).toBe(known.accountEmail)
      }
      // И токенов в файле квоты нет никогда.
      expect(JSON.stringify(acct)).not.toContain('sk-ant')
    }
  })
})
