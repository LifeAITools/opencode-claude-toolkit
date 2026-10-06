/**
 * КЛЕЙМО ЗАПУСКА СЕССИИ — launched_as, однократно (session-stamp.ts).
 *
 * ЗАЧЕМ. Семейство сборщика присутствия отвечает «чья сессия и какая последняя»
 * по клейму launched_as, а не по указателю присутствия. Хук Claude ставит его на
 * первом ходе (`context session stamp-launch`); адаптер opencode не ставил никогда —
 * поэтому в пуш уезжал старый рекорд вместо живой сессии. Ставится один раз на
 * процесс, при первой привязке настоящего номера сессии; запись однократна и на
 * стороне реестра, повтор безопасен. Нет личности в окружении — команда отказывает
 * сама (код 2), молча не гасим: исход едет в журнал строкой.
 */

export interface StampLaunchResult {
  ok: boolean
  /** Человекочитаемый итог для журнала (без секретов — их здесь нет). */
  detail: string
}

export type StampRunner = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>

/**
 * Поставить клеймо. Никогда не бросает: любая неудача — { ok:false, detail }.
 * onceGuard: объект-счётчик вызывающей стороны (один процесс — одно клеймо).
 */
export async function stampSessionLaunch(
  run: StampRunner,
  sessionId: string,
  cwd: string,
  onceGuard: { done?: boolean },
  now: Date = new Date(),
): Promise<StampLaunchResult> {
  void now
  if (!sessionId || sessionId === 'unknown') return { ok: false, detail: 'no_session_id' }
  if (onceGuard.done) return { ok: false, detail: 'already_stamped_this_process' }
  onceGuard.done = true
  if (!process.env.SYNQTASK_AGENT_ID || !process.env.KIBEROS_PROJECT_SLUG) {
    return { ok: false, detail: 'no_launch_identity_in_env' }
  }
  try {
    const r = await run('context', ['session', 'stamp-launch', '--session', sessionId, '--cwd', cwd], { timeoutMs: 20_000 })
    if (r.code !== 0) return { ok: false, detail: `exit_${r.code}:${(r.stderr || r.stdout).slice(0, 200)}` }
    return { ok: true, detail: r.stdout.slice(0, 200) || 'stamped' }
  } catch (e: any) {
    return { ok: false, detail: `runner_failed:${e?.message ?? String(e)}`.slice(0, 200) }
  }
}
