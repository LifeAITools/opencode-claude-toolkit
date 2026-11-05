import { describe, expect, test } from 'bun:test'
import { pickOpenDesignAccount, upstreamModel, type OdAccountView } from './modules/open-design-door.js'

const KEY = (email: string | null) =>
  email === 'relishev@gmail.com' ? 'OPEN_DESIGN_API_KEY'
    : email === 'hello@kiberos.app' ? 'OPEN_DESIGN_API_KEY_2'
      : null

const acc = (account: string, status: OdAccountView['status'], headroomFraction: number | null): OdAccountView =>
  ({ account, status, headroomFraction, windows: [] })

describe('выбор аккаунта OpenDesign по запасу', () => {
  test('берёт тот, где больше запас, а не первый в списке', () => {
    const pick = pickOpenDesignAccount([
      acc('relishev@gmail.com', 'active', 0.19),
      acc('hello@kiberos.app', 'active', 0.62),
    ], KEY)
    expect(pick?.email).toBe('hello@kiberos.app')
    expect(pick?.headroomFraction).toBeCloseTo(0.62)
  })

  test('absent / exhausted / unreadable не кандидаты', () => {
    const pick = pickOpenDesignAccount([
      acc('relishev@gmail.com', 'exhausted', 0),
      acc('hello@kiberos.app', 'unreadable', null),
      acc('team@x', 'absent', null),
    ], KEY)
    expect(pick).toBeNull()
  })

  test('аккаунт без объявленного ключа пропускается — ключом соседа не ходим', () => {
    const pick = pickOpenDesignAccount([
      acc('unknown@x', 'active', 0.99),
      acc('hello@kiberos.app', 'active', 0.10),
    ], KEY)
    expect(pick?.email).toBe('hello@kiberos.app')
  })

  test('неизмеренный запас идёт ПОСЛЕ измеренного, но не отбрасывается', () => {
    const pick = pickOpenDesignAccount([
      acc('hello@kiberos.app', 'active', null),
      acc('relishev@gmail.com', 'active', 0.05),
    ], KEY)
    expect(pick?.email).toBe('relishev@gmail.com')
    expect(pick?.why).toBe('headroom')

    const onlyUnmeasured = pickOpenDesignAccount([acc('hello@kiberos.app', 'active', null)], KEY)
    expect(onlyUnmeasured?.email).toBe('hello@kiberos.app')
    expect(onlyUnmeasured?.why).toBe('headroom_unmeasured')
  })

  test('ничья решается по email — порядок не прыгает между вызовами', () => {
    const pick = pickOpenDesignAccount([
      acc('relishev@gmail.com', 'active', 0.5),
      acc('hello@kiberos.app', 'active', 0.5),
    ], KEY)
    expect(pick?.email).toBe('hello@kiberos.app')
  })

  test('пустой список — null, а не выдуманный аккаунт', () => {
    expect(pickOpenDesignAccount([], KEY)).toBeNull()
  })
})

describe('имя модели наверх', () => {
  test('-od снимается: у поставщика такого суффикса нет', () => {
    expect(upstreamModel('deepseek-v4.1-flash-od')).toBe('deepseek-v4.1-flash')
  })
  test('прочие имена не трогаем', () => {
    expect(upstreamModel('deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash')
    expect(upstreamModel('qwen3.8-flash')).toBe('qwen3.8-flash')
  })
})
