/**
 * The live-session announcement of exec suppression: said once, and only for
 * the default nobody asked for.
 *
 * Why a test at all: `server:` runs per SESSION, so the first version of this
 * line repeated for every session an opencode process served — noise that gets
 * a warning muted, which is worse than no warning. The guard is the point, and
 * a guard nobody can observe is exactly the class of defect this whole thread
 * has been closing.
 *
 * Env is set INSIDE each test rather than at module load: a sibling suite sets
 * `SW_EXEC_OFF=1` process-wide, and bun shares the process across test files —
 * so anything read from ambient env here would depend on file order.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { warnIfExecSuppressedInLiveSession, execSuppressionAnnouncement } from './plugin'

const saved = {
  execOff: process.env.SW_EXEC_OFF,
  nodeEnv: process.env.NODE_ENV,
  bunEnv: process.env.BUN_ENV,
  inTests: process.env.SW_EXEC_IN_TESTS,
}
let lines: string[] = []
let realError: typeof console.error

beforeEach(() => {
  lines = []
  realError = console.error
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
})

afterEach(() => {
  console.error = realError
  for (const [k, v] of Object.entries({
    SW_EXEC_OFF: saved.execOff, NODE_ENV: saved.nodeEnv,
    BUN_ENV: saved.bunEnv, SW_EXEC_IN_TESTS: saved.inTests,
  })) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('exec-suppression announcement (live session)', () => {
  test('an unasked-for default is announced ONCE, however many sessions', () => {
    delete process.env.SW_EXEC_OFF
    delete process.env.SW_EXEC_IN_TESTS
    process.env.NODE_ENV = 'test'

    warnIfExecSuppressedInLiveSession()   // session 1
    warnIfExecSuppressedInLiveSession()   // session 2
    warnIfExecSuppressedInLiveSession()   // session 3

    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('SUPPRESSED')
    // The reason travels with it — a warning that will not say why gets ignored.
    expect(lines[0]!.length).toBeGreaterThan(60)
  })

  // The decision itself, asked WITHOUT the once-guard in the way — otherwise
  // the guard (already tripped above) would swallow every call and these would
  // pass whatever the function decided.
  test('our own deliberate switch says nothing', () => {
    process.env.SW_EXEC_OFF = '1'
    process.env.NODE_ENV = 'test'
    expect(execSuppressionAnnouncement()).toBeNull()
  })

  test('a real session with nothing suppressed says nothing', () => {
    delete process.env.SW_EXEC_OFF
    delete process.env.NODE_ENV
    delete process.env.BUN_ENV
    expect(execSuppressionAnnouncement()).toBeNull()
  })

  test('the unasked-for default DOES produce a line, and it names the reason', () => {
    delete process.env.SW_EXEC_OFF
    delete process.env.SW_EXEC_IN_TESTS
    process.env.NODE_ENV = 'test'
    const line = execSuppressionAnnouncement()
    expect(line).not.toBeNull()
    expect(line!).toContain('SUPPRESSED')
    expect(line!).toContain('test-runner')
  })
})
