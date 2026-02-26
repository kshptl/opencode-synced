export interface SyncLockInfo {
    pid: number;
    startedAt: string;
    hostname: string;
}
export type SyncLockResult = {
    acquired: true;
    info: SyncLockInfo;
    release: () => Promise<void>;
} | {
    acquired: false;
    info: SyncLockInfo | null;
};
export declare function tryAcquireSyncLock(lockPath: string): Promise<SyncLockResult>;
export declare function withSyncLock<T>(lockPath: string, options: {
    onBusy: (info: SyncLockInfo | null) => T | Promise<T>;
}, fn: () => Promise<T>): Promise<T>;
