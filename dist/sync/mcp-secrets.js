import { deepMerge, hasOwn, isPlainObject } from './config.js';
const ENV_PLACEHOLDER_PATTERN = /\{env:[^}]+\}/i;
export function extractMcpSecrets(config) {
    const sanitizedConfig = cloneConfig(config);
    const secretOverrides = {};
    const mcp = getPlainObject(sanitizedConfig.mcp);
    if (!mcp) {
        return { sanitizedConfig, secretOverrides };
    }
    for (const [serverName, serverConfigValue] of Object.entries(mcp)) {
        const serverConfig = getPlainObject(serverConfigValue);
        if (!serverConfig)
            continue;
        const headers = getPlainObject(serverConfig.headers);
        if (headers) {
            for (const [headerName, headerValue] of Object.entries(headers)) {
                if (!isSecretString(headerValue))
                    continue;
                const envVar = buildHeaderEnvVar(serverName, headerName);
                const placeholder = buildHeaderPlaceholder(String(headerValue), envVar, headerName);
                headers[headerName] = placeholder;
                setNestedValue(secretOverrides, ['mcp', serverName, 'headers', headerName], headerValue);
            }
        }
        const oauth = getPlainObject(serverConfig.oauth);
        if (oauth) {
            const clientSecret = oauth.clientSecret;
            if (isSecretString(clientSecret)) {
                const envVar = buildEnvVar(serverName, 'OAUTH_CLIENT_SECRET');
                oauth.clientSecret = `{env:${envVar}}`;
                setNestedValue(secretOverrides, ['mcp', serverName, 'oauth', 'clientSecret'], clientSecret);
            }
        }
    }
    return { sanitizedConfig, secretOverrides };
}
function isSecretString(value) {
    return typeof value === 'string' && value.length > 0 && !ENV_PLACEHOLDER_PATTERN.test(value);
}
function buildHeaderEnvVar(serverName, headerName) {
    if (/^[A-Z0-9_]+$/.test(headerName)) {
        return headerName;
    }
    return buildEnvVar(serverName, headerName);
}
function buildEnvVar(serverName, key) {
    const serverToken = toEnvToken(serverName, 'SERVER');
    const keyToken = toEnvToken(key, 'VALUE');
    return `opencode_mcp_${serverToken}_${keyToken}`;
}
function toEnvToken(input, fallback) {
    const cleaned = String(input)
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!cleaned)
        return fallback;
    return cleaned.toUpperCase();
}
function buildHeaderPlaceholder(value, envVar, headerName) {
    if (!isAuthorizationHeader(headerName)) {
        return `{env:${envVar}}`;
    }
    const schemeMatch = value.match(/^([A-Za-z][A-Za-z0-9+.-]*)\s+/);
    if (schemeMatch) {
        return `${schemeMatch[0]}{env:${envVar}}`;
    }
    return `{env:${envVar}}`;
}
function isAuthorizationHeader(headerName) {
    if (!headerName)
        return false;
    const normalized = headerName.toLowerCase();
    return normalized === 'authorization' || normalized === 'proxy-authorization';
}
function setNestedValue(target, path, value) {
    let current = target;
    for (let i = 0; i < path.length - 1; i += 1) {
        const key = path[i];
        const next = current[key];
        if (!isPlainObject(next)) {
            current[key] = {};
        }
        current = current[key];
    }
    current[path[path.length - 1]] = value;
}
function getPlainObject(value) {
    return isPlainObject(value) ? value : null;
}
function cloneConfig(config) {
    return JSON.parse(JSON.stringify(config));
}
export function mergeOverrides(base, extra) {
    return deepMerge(base, extra);
}
export function stripOverrideKeys(base, toRemove) {
    if (!isPlainObject(base) || !isPlainObject(toRemove)) {
        return base;
    }
    const result = { ...base };
    for (const [key, removeValue] of Object.entries(toRemove)) {
        if (!hasOwn(result, key))
            continue;
        const currentValue = result[key];
        if (isPlainObject(removeValue) && isPlainObject(currentValue)) {
            const stripped = stripOverrideKeys(currentValue, removeValue);
            if (Object.keys(stripped).length === 0) {
                delete result[key];
            }
            else {
                result[key] = stripped;
            }
            continue;
        }
        delete result[key];
    }
    return result;
}
export function hasOverrides(value) {
    return Object.keys(value).length > 0;
}
