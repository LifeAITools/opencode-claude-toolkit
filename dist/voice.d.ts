export interface VoiceStreamCallbacks {
    onTranscript: (text: string, isFinal: boolean) => void;
    onError: (error: string, opts?: {
        fatal?: boolean;
    }) => void;
    onClose: () => void;
}
export interface VoiceStreamConnection {
    send: (audioChunk: Buffer) => void;
    finalize: () => Promise<string>;
    close: () => void;
    isConnected: () => boolean;
}
export interface VoiceStreamOptions {
    language?: string;
    keyterms?: string[];
    baseUrl?: string;
}
export interface TranscribeFileOptions extends VoiceStreamOptions {
    onInterim?: (text: string) => void;
    realtime?: boolean;
}
export declare function connectVoiceStream(accessToken: string, callbacks: VoiceStreamCallbacks, options?: VoiceStreamOptions): Promise<VoiceStreamConnection>;
export declare function transcribeFile(accessToken: string, filePath: string, options?: TranscribeFileOptions): Promise<string>;
export declare function transcribeAudioFile(accessToken: string, filePath: string, options?: TranscribeFileOptions): Promise<string>;
export declare function startMicRecording(onData: (chunk: Buffer) => void, onEnd: () => void): {
    stop: () => void;
} | null;
export declare function checkVoiceDeps(): {
    available: boolean;
    tool: string | null;
    installHint: string | null;
};
