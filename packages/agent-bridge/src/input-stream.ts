/**
 * Push-based `AsyncIterable<SDKUserMessage>` — the streaming-input channel the SDK
 * `query({ prompt })` consumes. External controllers (a socket, a queue, the
 * wake-router) `push()` user messages; the agent receives them mid-session. This is
 * the ONLY supported way to feed a running streaming agent, per the SDK.
 */
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export class InputStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiter: ((v: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  /** Enqueue a user message for the agent. No-op after close(). */
  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  /** Convenience: push a plain-text user turn. */
  pushText(text: string, sessionId?: string): void {
    this.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId ?? "",
    } as SDKUserMessage);
  }

  /** Close the stream — ends the agent's input (agent finishes current work, stops). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({
            value: undefined as unknown as SDKUserMessage,
            done: true,
          });
        }
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}
