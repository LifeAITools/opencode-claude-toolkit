import type { MessageParam } from "./types.js";
export interface SessionEntry {
    type: "user" | "assistant";
    uuid: string;
    parentUuid: string | null;
    timestamp: number;
    content: MessageParam["content"];
}
export declare function saveSession(path: string, messages: readonly MessageParam[]): void;
export declare function loadSession(path: string): MessageParam[];
