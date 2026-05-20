/**
 * SDK Worker — runs ClaudeCodeSDK outside Bun.serve context.
 * Communicates via stdin/stdout JSON lines.
 * Each line: {"type":"request"|"response"|"event"|"done"|"error"|"ready", ...}
 */
import { ClaudeCodeSDK } from '@life-ai-tools/claude-code-sdk'

interface WorkerRequest {
  id: string
  mode: 'generate' | 'stream'
  credentialsPath: string
  options: {
    model: string
    messages: { role: string; content: unknown }[]
    system?: string
    maxTokens: number
    tools?: unknown[]
    toolChoice?: unknown
    temperature?: number
    effort?: string
    thinking?: { type: string; budgetTokens: number }
  }
}

const sdk = new ClaudeCodeSDK()

async function handleRequest(req: WorkerRequest) {
  try {
    const { readFileSync } = await import('fs')
    const raw = readFileSync(req.credentialsPath, 'utf8')
    const oauth = JSON.parse(raw).claudeAiOauth

    const workerSdk = new ClaudeCodeSDK({
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
    })

    const opts: any = {
      model: req.options.model,
      messages: req.options.messages,
      maxTokens: req.options.maxTokens,
    }
    if (req.options.system) opts.system = req.options.system
    if (req.options.tools?.length) opts.tools = req.options.tools
    if (req.options.toolChoice) opts.toolChoice = req.options.toolChoice
    if (req.options.temperature !== undefined) opts.temperature = req.options.temperature
    if (req.options.effort) opts.effort = req.options.effort
    if (req.options.thinking) opts.thinking = req.options.thinking

    if (req.mode === 'generate') {
      const response = await workerSdk.generate(opts)
      const textContent = response.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.type === 'text' ? b.text : '')
        .join('')
      const toolCalls = response.toolCalls?.map((tc: any, i: number) => ({
        id: tc.id ?? `call_${i}`,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
      }))
      console.error(`[worker] generate: text=${textContent.slice(0, 80)} toolCalls=${toolCalls?.length ?? 0}`)
      if (toolCalls?.length) {
        for (const tc of toolCalls) {
          console.error(`[worker] tool_call: id=${tc.id} name=${tc.function.name} args=${tc.function.arguments.slice(0, 200)}`)
        }
      }
      if (response.toolCalls?.length) {
        for (const tc of response.toolCalls) {
          console.error(`[worker] SDK toolCall: name=${tc.name} inputType=${typeof tc.input} input=${JSON.stringify(tc.input).slice(0, 200)}`)
        }
      }
      sendResponse(req.id, {
        text: textContent,
        toolCalls,
        stopReason: response.stopReason,
        usage: response.usage,
      })
    } else {
      for await (const event of workerSdk.stream(opts)) {
        sendEvent(req.id, event)
      }
      sendDone(req.id)
    }
  } catch (err) {
    sendError(req.id, err instanceof Error ? err.message : String(err))
  }
}

function sendResponse(id: string, data: unknown) {
  process.stdout.write(JSON.stringify({ type: 'response', id, data }) + '\n')
}

function sendEvent(id: string, event: unknown) {
  process.stdout.write(JSON.stringify({ type: 'event', id, event }) + '\n')
}

function sendDone(id: string) {
  process.stdout.write(JSON.stringify({ type: 'done', id }) + '\n')
}

function sendError(id: string, message: string) {
  process.stdout.write(JSON.stringify({ type: 'error', id, message }) + '\n')
}

process.stdin.on('data', (chunk) => {
  const lines = chunk.toString().split('\n').filter(Boolean)
  for (const line of lines) {
    try {
      const req: WorkerRequest = JSON.parse(line)
      void handleRequest(req)
    } catch { /* skip */ }
  }
})

process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n')
