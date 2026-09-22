/**
 * sse-usage-tee — ловля `usage` из OpenAI-совместимого SSE-стрима.
 *
 * Обёртка над читаемым потоком: байты идут НАРУЖУ БАЙТ-В-БАЙТ (прокси прозрачен), а
 * параллельно из текста вылавливается `usage` — OpenAI-совместимый формат кладёт его в
 * предпоследний `data: {…}`, затем `data: [DONE]`.
 */

export interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

export function teeUsage(
  body: ReadableStream<Uint8Array>,
  onUsage: (usage: OpenAIUsage) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  return new ReadableStream({
    async pull(controller) {
      const chunk = await reader.read()
      if (chunk.done) {
        try {
          controller.close()
        } catch {}
        return
      }
      const value = chunk.value
      controller.enqueue(value)
      buf += decoder.decode(value, { stream: true })
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data && data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data) as { usage?: OpenAIUsage }
              if (parsed && parsed.usage) onUsage(parsed.usage)
            } catch {
              /* не-JSON data — пропускаем */
            }
          }
        }
        nl = buf.indexOf('\n')
      }
    },
    cancel(reason) {
      reader.cancel(reason)
    },
  })
}