export declare class SyncError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class SyncConfigMissingError extends SyncError {
    constructor(message: string);
}
export declare class RepoDivergedError extends SyncError {
    constructor(message: string);
}
export declare class RepoPrivateRequiredError extends SyncError {
    constructor(message: string);
}
export declare class RepoVisibilityError extends SyncError {
    constructor(message: string);
}
export declare class SyncCommandError extends SyncError {
    constructor(message: string);
}
