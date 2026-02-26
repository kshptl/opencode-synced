import { mkdir, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
function isProcessAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        const maybeErrno = error;
        if (maybeErrno.code === 'ESRCH')
            return false;
        return true;
    }
}
async function readLockInfo(lockPath) {
    try {
        const content = await readFile(lockPath, 'utf8');
        const parsed = JSON.parse(content);
        if (typeof parsed.pid !== 'number')
            return null;
        if (typeof parsed.startedAt !== 'string')
            return null;
        if (typeof parsed.hostname !== 'string')
            return null;
        return {
            pid: parsed.pid,
            startedAt: parsed.startedAt,
            hostname: parsed.hostname,
        };
    }
    catch (error) {
        const maybeErrno = error;
        if (maybeErrno.code === 'ENOENT')
            return null;
        return null;
    }
}
export async function tryAcquireSyncLock(lockPath) {
    const parentDir = path.dirname(lockPath);
    await mkdir(parentDir, { recursive: true });
    const ourInfo = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        hostname: os.hostname(),
    };
    let attempt = 0;
    while (true) {
        try {
            const handle = await open(lockPath, 'wx');
            await handle.writeFile(`${JSON.stringify(ourInfo, null, 2)}\n`, 'utf8');
            return {
                acquired: true,
                info: ourInfo,
                release: async () => {
                    await handle.close().catch(() => {
                        // ignore close failures
                    });
                    await rm(lockPath, { force: true });
                },
            };
        }
        catch (error) {
            const maybeErrno = error;
            if (maybeErrno.code !== 'EEXIST')
                throw error;
            const existing = await readLockInfo(lockPath);
            const shouldBreakLock = existing === null || !isProcessAlive(existing.pid);
            if (attempt === 0 && shouldBreakLock) {
                await rm(lockPath, { force: true });
                attempt += 1;
                continue;
            }
            return { acquired: false, info: existing };
        }
    }
}
export async function withSyncLock(lockPath, options, fn) {
    const result = await tryAcquireSyncLock(lockPath);
    if (!result.acquired) {
        return await options.onBusy(result.info);
    }
    try {
        return await fn();
    }
    finally {
        await result.release();
    }
}
