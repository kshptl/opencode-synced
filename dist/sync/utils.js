const SERVICE_NAME = 'opencode-synced';
export function createLogger(client) {
    return {
        debug: (message, extra) => log(client, 'debug', message, extra),
        info: (message, extra) => log(client, 'info', message, extra),
        warn: (message, extra) => log(client, 'warn', message, extra),
        error: (message, extra) => log(client, 'error', message, extra),
    };
}
function log(client, level, message, extra) {
    client.app
        .log({
        body: {
            service: SERVICE_NAME,
            level,
            message,
            extra,
        },
    })
        .catch((err) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(client, `Logging failed: ${errorMsg}`, 'error');
    });
}
export async function showToast(client, message, variant) {
    try {
        await client.tui.showToast({
            body: { title: 'opencode-synced plugin', message, variant },
        });
    }
    catch {
        // Ignore toast failures (e.g. headless mode or early startup).
    }
}
export function unwrapData(response) {
    if (!response || typeof response !== 'object')
        return null;
    const maybeError = response.error;
    if (maybeError)
        return null;
    if ('data' in response) {
        const data = response.data;
        if (data !== undefined)
            return data;
        return null;
    }
    return response;
}
export function extractTextFromResponse(response) {
    if (!response || typeof response !== 'object')
        return null;
    const parts = response.parts ??
        response.info?.parts ??
        [];
    const textPart = parts.find((part) => part.type === 'text' && part.text);
    return textPart?.text?.trim() ?? null;
}
export async function resolveSmallModel(client) {
    try {
        const response = await client.config.get();
        const config = unwrapData(response);
        if (!config)
            return null;
        const modelValue = config.small_model ?? config.model;
        if (!modelValue)
            return null;
        const [providerID, modelID] = modelValue.split('/', 2);
        if (!providerID || !modelID)
            return null;
        return { providerID, modelID };
    }
    catch {
        return null;
    }
}
