export declare function acquireConfigDirLock(configDir: string, maxRetries?: number): Promise<(() => Promise<void>) | null>;
