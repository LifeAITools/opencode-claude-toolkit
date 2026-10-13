export interface StreamTrace {
    session_id: string;
    harness: "claude-code";
    chars: number;
    deltas: number;
    stream_started_at: string;
    last_delta_at: string;
    ended_at?: string;
}
export declare function streamTraceDir(): string;
export declare function streamTracePath(dir: string, sessionId: string): string;
export declare const STREAM_TRACE_INTERVAL_MS = 5000;
export declare class StreamTracer {
    private readonly dir;
    private readonly live;
    private readonly intervalMs;
    constructor(dir: string, intervalMs?: number);
    delta(sessionId: string, text: string): void;
    end(sessionId: string): void;
    private write;
}
