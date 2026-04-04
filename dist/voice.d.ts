/**
 * Voice STT — Speech-to-Text via Anthropic's voice_stream WebSocket endpoint.
 *
 * Architecture: transcribe-then-submit (NOT native multimodal audio).
 * The voice_stream endpoint is a private Anthropic API that accepts raw PCM
 * audio over WebSocket and returns text transcripts via Deepgram Nova 3.
 *
 * Wire protocol (from Claude Code CLI src/services/voiceStreamSTT.ts):
 *   Client → Server: binary audio frames (raw PCM 16kHz/16bit/mono)
 *   Client → Server: JSON control messages (KeepAlive, CloseStream)
 *   Server → Client: JSON transcript messages (TranscriptText, TranscriptEndpoint, TranscriptError)
 *
 * Sources:
 *   - src/services/voiceStreamSTT.ts — WebSocket STT client
 *   - src/services/voice.ts — Audio recording (cpal/SoX/arecord)
 *   - src/hooks/useVoice.ts — React hook for hold-to-talk
 *   - src/constants/oauth.ts:85 — BASE_API_URL = 'https://api.anthropic.com'
 */
export interface VoiceStreamCallbacks {
    /** Called with transcript text. isFinal=true means this segment is complete. */
    onTranscript: (text: string, isFinal: boolean) => void;
    /** Called on errors. fatal=true means the connection should not be retried. */
    onError: (error: string, opts?: {
        fatal?: boolean;
    }) => void;
    /** Called when the WebSocket closes. */
    onClose: () => void;
}
export interface VoiceStreamConnection {
    /** Send a raw PCM audio chunk (16kHz, 16-bit signed LE, mono). */
    send: (audioChunk: Buffer) => void;
    /** Signal end of audio. Returns when the server has flushed final transcript. */
    finalize: () => Promise<string>;
    /** Close the WebSocket immediately. */
    close: () => void;
    /** Check if the WebSocket is still connected. */
    isConnected: () => boolean;
}
export interface VoiceStreamOptions {
    /** BCP-47 language code for STT. Default: 'en' */
    language?: string;
    /** Domain-specific vocabulary hints for better recognition. */
    keyterms?: string[];
    /** WebSocket base URL override. Default: wss://api.anthropic.com */
    baseUrl?: string;
}
export interface TranscribeFileOptions extends VoiceStreamOptions {
    /** Callback for interim transcripts (live preview). */
    onInterim?: (text: string) => void;
    /** If true, stream at real-time pace. If false (default), stream as fast as endpoint allows. */
    realtime?: boolean;
}
/**
 * Connect to Anthropic's voice_stream WebSocket endpoint for STT.
 *
 * Matches the exact protocol from Claude Code CLI (voiceStreamSTT.ts):
 * - URL: wss://api.anthropic.com/api/ws/speech_to_text/voice_stream
 * - Auth: Bearer OAuth token
 * - Headers: User-Agent: claude-cli/..., x-app: cli
 * - Query: encoding=linear16&sample_rate=16000&channels=1&endpointing_ms=300&utterance_end_ms=1000&language=en
 *
 * @param accessToken - OAuth access token (same one used for Messages API)
 * @param callbacks - Transcript/error/close callbacks
 * @param options - Language, keyterms, base URL override
 */
export declare function connectVoiceStream(accessToken: string, callbacks: VoiceStreamCallbacks, options?: VoiceStreamOptions): Promise<VoiceStreamConnection>;
/**
 * Transcribe a raw PCM file (16kHz, 16-bit signed LE, mono) via voice_stream.
 *
 * The file is streamed in chunks that approximate real-time pace to avoid
 * overwhelming the endpoint or triggering anti-abuse protections.
 *
 * @param accessToken - OAuth access token
 * @param filePath - Path to raw PCM file (or WAV — 44-byte header is auto-stripped)
 * @param options - Language, keyterms, callbacks
 * @returns Full transcription text
 */
export declare function transcribeFile(accessToken: string, filePath: string, options?: TranscribeFileOptions): Promise<string>;
/**
 * Convert an audio file to raw PCM (16kHz, 16-bit signed LE, mono) using ffmpeg or sox,
 * then transcribe via voice_stream.
 *
 * Supports: .mp3, .wav, .ogg, .flac, .m4a, .webm, .opus, .aac
 *
 * @param accessToken - OAuth access token
 * @param filePath - Path to any supported audio file
 * @param options - Language, keyterms, callbacks
 * @returns Full transcription text
 */
export declare function transcribeAudioFile(accessToken: string, filePath: string, options?: TranscribeFileOptions): Promise<string>;
/**
 * Record from microphone using SoX (rec) or arecord.
 * Returns a handle to stop recording and get the audio data callback.
 *
 * Fallback chain (from Claude Code voice.ts):
 * 1. SoX `rec` (macOS/Linux)
 * 2. `arecord` (Linux ALSA)
 */
export declare function startMicRecording(onData: (chunk: Buffer) => void, onEnd: () => void): {
    stop: () => void;
} | null;
/**
 * Check what audio recording tools are available.
 */
export declare function checkVoiceDeps(): {
    available: boolean;
    tool: string | null;
    installHint: string | null;
};
//# sourceMappingURL=voice.d.ts.map