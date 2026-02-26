import { extractTextFromResponse, resolveSmallModel, unwrapData } from './utils.js';
export async function generateCommitMessage(ctx, repoDir, fallbackDate = new Date()) {
    const fallback = `Sync opencode config (${formatDate(fallbackDate)})`;
    const diffSummary = await getDiffSummary(ctx.$, repoDir);
    if (!diffSummary)
        return fallback;
    const model = await resolveSmallModel(ctx.client);
    if (!model)
        return fallback;
    const prompt = [
        'Generate a concise single-line git commit message (max 72 chars).',
        'Focus on opencode config sync changes.',
        'Return only the message, no quotes.',
        '',
        'Diff summary:',
        diffSummary,
    ].join('\n');
    let sessionId = null;
    try {
        const sessionResult = await ctx.client.session.create({ body: { title: 'opencode-synced' } });
        const session = unwrapData(sessionResult);
        sessionId = session?.id ?? null;
        if (!sessionId)
            return fallback;
        const response = await ctx.client.session.prompt({
            path: { id: sessionId },
            body: {
                model,
                parts: [{ type: 'text', text: prompt }],
            },
        });
        const message = extractTextFromResponse(unwrapData(response) ?? response);
        if (!message)
            return fallback;
        const sanitized = sanitizeMessage(message);
        return sanitized || fallback;
    }
    catch {
        return fallback;
    }
    finally {
        if (sessionId) {
            try {
                await ctx.client.session.delete({ path: { id: sessionId } });
            }
            catch { }
        }
    }
}
function sanitizeMessage(message) {
    const firstLine = message.split('\n')[0].trim();
    const trimmed = firstLine.replace(/^["'`]+|["'`]+$/g, '').trim();
    if (!trimmed)
        return '';
    if (trimmed.length <= 72)
        return trimmed;
    return trimmed.slice(0, 72).trim();
}
async function getDiffSummary($, repoDir) {
    try {
        const nameStatus = await $ `git -C ${repoDir} diff --name-status`.quiet().text();
        const stats = await $ `git -C ${repoDir} diff --stat`.quiet().text();
        return [nameStatus.trim(), stats.trim()].filter(Boolean).join('\n');
    }
    catch {
        return '';
    }
}
function formatDate(date) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
