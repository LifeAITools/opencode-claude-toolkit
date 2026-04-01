import type { MessageParam } from './types.js';
export interface SessionEntry {
    type: 'user' | 'assistant';
    uuid: string;
    parentUuid: string | null;
    timestamp: number;
    content: MessageParam['content'];
}
/** Save conversation messages to JSONL file (CLI-compatible format) */
export declare function saveSession(path: string, messages: readonly MessageParam[]): void;
/** Load conversation messages from JSONL file */
export declare function loadSession(path: string): MessageParam[];
//# sourceMappingURL=session.d.ts.map