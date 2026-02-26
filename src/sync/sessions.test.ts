import path from 'node:path';
import type { AssistantMessage, Part, Session, UserMessage } from '@opencode-ai/sdk';
import { describe, expect, it } from 'vitest';

import {
  buildRecentToolPartIds,
  COMPACT_REASONING_PLACEHOLDER,
  COMPACT_TOOL_PLACEHOLDER,
  type MessageExport,
  pruneMessages,
  prunePartCompact,
  rewriteSessionPaths,
  SESSION_ID_RE,
  safeSessionPath,
} from './sessions.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(directory: string): Session {
  return {
    id: 'ses_testSession01',
    projectID: 'proj_1',
    directory,
    title: 'Test session',
    version: '1',
    time: { created: 1000, updated: 2000 },
  };
}

function makeUserMessage(id = 'msg_user01'): UserMessage {
  return {
    id,
    sessionID: 'ses_testSession01',
    role: 'user',
    time: { created: 1000 },
    agent: 'default',
    model: { providerID: 'anthropic', modelID: 'claude-3' },
  };
}

function makeAssistantMessage(
  id = 'msg_asst01',
  cwd = '/project',
  root = '/project'
): AssistantMessage {
  return {
    id,
    sessionID: 'ses_testSession01',
    role: 'assistant',
    time: { created: 1100 },
    parentID: 'msg_user01',
    modelID: 'claude-3',
    providerID: 'anthropic',
    mode: 'auto',
    path: { cwd, root },
    cost: 0.001,
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function makeToolPart(
  id: string,
  status: 'completed' | 'running' | 'pending' | 'error',
  output = 'big output here'
): Extract<Part, { type: 'tool' }> {
  const base = {
    id,
    sessionID: 'ses_testSession01',
    messageID: 'msg_asst01',
    type: 'tool' as const,
    callID: `call_${id}`,
    tool: 'bash',
  };

  if (status === 'completed') {
    return {
      ...base,
      state: {
        status: 'completed',
        input: { command: 'ls' },
        output,
        title: 'bash',
        metadata: {},
        time: { start: 1100, end: 1200 },
      },
    };
  }

  if (status === 'running') {
    return {
      ...base,
      state: {
        status: 'running',
        input: { command: 'ls' },
        time: { start: 1100 },
      },
    };
  }

  if (status === 'error') {
    return {
      ...base,
      state: {
        status: 'error',
        input: { command: 'ls' },
        error: 'command not found',
        time: { start: 1100, end: 1200 },
      },
    };
  }

  // pending
  return {
    ...base,
    state: {
      status: 'pending',
      input: { command: 'ls' },
      raw: 'ls',
    },
  };
}

function makeTextPart(id: string, text = 'hello'): Extract<Part, { type: 'text' }> {
  return {
    id,
    sessionID: 'ses_testSession01',
    messageID: 'msg_asst01',
    type: 'text',
    text,
  };
}

function makeReasoningPart(
  id: string,
  reasoning = 'thinking...'
): Extract<Part, { type: 'reasoning' }> {
  return {
    id,
    sessionID: 'ses_testSession01',
    messageID: 'msg_asst01',
    type: 'reasoning',
    reasoning,
  };
}

function makeMsg(info: UserMessage | AssistantMessage, parts: Part[] = []): MessageExport {
  return { info, parts };
}

// ─── SESSION_ID_RE ────────────────────────────────────────────────────────────

describe('SESSION_ID_RE', () => {
  it('accepts valid session IDs', () => {
    expect(SESSION_ID_RE.test('ses_abc1234567')).toBe(true);
    expect(SESSION_ID_RE.test('ses_ABCDEF123456789012')).toBe(true);
    expect(SESSION_ID_RE.test('ses_a1B2c3D4e5F6')).toBe(true);
  });

  it('rejects IDs without ses_ prefix', () => {
    expect(SESSION_ID_RE.test('abc1234567')).toBe(false);
    expect(SESSION_ID_RE.test('msg_abc1234567')).toBe(false);
  });

  it('rejects IDs that are too short after prefix', () => {
    expect(SESSION_ID_RE.test('ses_short')).toBe(false); // 5 chars — min is 10
  });

  it('rejects IDs that are too long after prefix', () => {
    const long = 'ses_' + 'a'.repeat(51);
    expect(SESSION_ID_RE.test(long)).toBe(false);
  });

  it('rejects IDs with path traversal characters', () => {
    expect(SESSION_ID_RE.test('ses_../../etc/passwd')).toBe(false);
    expect(SESSION_ID_RE.test('ses_abc/def123456')).toBe(false);
    expect(SESSION_ID_RE.test('ses_abc\\def123456')).toBe(false);
  });

  it('rejects IDs with special characters', () => {
    expect(SESSION_ID_RE.test('ses_abc!@#$1234')).toBe(false);
    expect(SESSION_ID_RE.test('ses_abc 1234567')).toBe(false);
  });
});

// ─── safeSessionPath ─────────────────────────────────────────────────────────

describe('safeSessionPath', () => {
  const repoRoot = '/tmp/test-repo';

  it('returns correct path for valid session ID', () => {
    const p = safeSessionPath(repoRoot, 'ses_abc1234567', '.jsonl');
    expect(p).toBe(path.join(repoRoot, 'data', 'sessions', 'ses_abc1234567.jsonl'));
  });

  it('throws for invalid session ID format', () => {
    expect(() => safeSessionPath(repoRoot, 'invalid_id', '.jsonl')).toThrow(
      'Invalid session ID format'
    );
  });

  it('throws for path traversal in session ID', () => {
    // Even if somehow a traversal ID passed the regex, the containment check catches it.
    // We test by checking that a crafted suffix would be caught.
    expect(() => safeSessionPath(repoRoot, 'ses_abc1234567', '/../../../etc/passwd')).toThrow();
  });
});

// ─── buildRecentToolPartIds ───────────────────────────────────────────────────

describe('buildRecentToolPartIds', () => {
  it('returns empty set when keepCount is 0', () => {
    const msgs = [
      makeMsg(makeAssistantMessage(), [
        makeToolPart('t1', 'completed'),
        makeToolPart('t2', 'completed'),
      ]),
    ];
    const ids = buildRecentToolPartIds(msgs, 0);
    expect(ids.size).toBe(0);
  });

  it('returns all IDs when fewer tools than keepCount', () => {
    const msgs = [
      makeMsg(makeAssistantMessage(), [
        makeToolPart('t1', 'completed'),
        makeToolPart('t2', 'completed'),
      ]),
    ];
    const ids = buildRecentToolPartIds(msgs, 5);
    expect(ids).toEqual(new Set(['t1', 't2']));
  });

  it('returns only the last N when more tools than keepCount', () => {
    const msgs = [
      makeMsg(makeAssistantMessage('msg1'), [
        makeToolPart('t1', 'completed'),
        makeToolPart('t2', 'completed'),
        makeToolPart('t3', 'completed'),
      ]),
      makeMsg(makeAssistantMessage('msg2'), [
        makeToolPart('t4', 'completed'),
        makeToolPart('t5', 'completed'),
        makeToolPart('t6', 'completed'),
      ]),
    ];
    const ids = buildRecentToolPartIds(msgs, 3);
    expect(ids).toEqual(new Set(['t4', 't5', 't6']));
  });

  it('ignores non-completed tool parts', () => {
    const msgs = [
      makeMsg(makeAssistantMessage(), [
        makeToolPart('t1', 'completed'),
        makeToolPart('t2', 'running'),
        makeToolPart('t3', 'pending'),
        makeToolPart('t4', 'error'),
      ]),
    ];
    const ids = buildRecentToolPartIds(msgs, 10);
    // Only completed parts count
    expect(ids).toEqual(new Set(['t1']));
  });

  it('collects tool parts across multiple messages in order', () => {
    const msgs = [
      makeMsg(makeAssistantMessage('msg1'), [makeToolPart('t1', 'completed')]),
      makeMsg(makeAssistantMessage('msg2'), [makeToolPart('t2', 'completed')]),
      makeMsg(makeAssistantMessage('msg3'), [makeToolPart('t3', 'completed')]),
    ];
    const ids = buildRecentToolPartIds(msgs, 2);
    expect(ids).toEqual(new Set(['t2', 't3']));
  });
});

// ─── prunePartCompact ─────────────────────────────────────────────────────────

describe('prunePartCompact', () => {
  it('clears output of completed tool part not in recent set', () => {
    const tool = makeToolPart('t1', 'completed', 'sensitive output');
    const pruned = prunePartCompact(tool, new Set()) as Extract<Part, { type: 'tool' }>;

    expect(pruned.type).toBe('tool');
    expect(pruned.state.status).toBe('completed');
    if (pruned.state.status === 'completed') {
      expect(pruned.state.output).toBe(COMPACT_TOOL_PLACEHOLDER);
      expect(pruned.state.attachments).toBeUndefined();
    }
  });

  it('keeps completed tool part in recent set unchanged', () => {
    const tool = makeToolPart('t1', 'completed', 'important output');
    const pruned = prunePartCompact(tool, new Set(['t1'])) as Extract<Part, { type: 'tool' }>;

    expect(pruned.state.status).toBe('completed');
    if (pruned.state.status === 'completed') {
      expect(pruned.state.output).toBe('important output');
    }
  });

  it('does not prune running or pending tool parts', () => {
    const running = makeToolPart('t1', 'running');
    const pending = makeToolPart('t2', 'pending');

    const prunedRunning = prunePartCompact(running, new Set());
    const prunedPending = prunePartCompact(pending, new Set());

    expect(prunedRunning).toEqual(running);
    expect(prunedPending).toEqual(pending);
  });

  it('clears reasoning part text', () => {
    const reasoning = makeReasoningPart('r1', 'I am thinking about this carefully...');
    const pruned = prunePartCompact(reasoning, new Set()) as Extract<Part, { type: 'reasoning' }>;

    expect(pruned.type).toBe('reasoning');
    expect(pruned.reasoning).toBe(COMPACT_REASONING_PLACEHOLDER);
  });

  it('keeps text part unchanged', () => {
    const text = makeTextPart('p1', 'Hello world');
    const pruned = prunePartCompact(text, new Set());
    expect(pruned).toEqual(text);
  });

  it('keeps non-tool non-reasoning parts unchanged', () => {
    const step: Part = {
      id: 's1',
      sessionID: 'ses_testSession01',
      messageID: 'msg_asst01',
      type: 'step-start',
    };
    expect(prunePartCompact(step, new Set())).toEqual(step);
  });
});

// ─── pruneMessages ────────────────────────────────────────────────────────────

describe('pruneMessages', () => {
  it('returns messages unchanged in full mode', () => {
    const msgs = [
      makeMsg(makeAssistantMessage(), [
        makeToolPart('t1', 'completed', 'big output'),
        makeReasoningPart('r1', 'deep thoughts'),
      ]),
    ];
    const result = pruneMessages(msgs, { mode: 'full', keepRecentToolResults: 5 });

    const tool = result[0].parts[0] as Extract<Part, { type: 'tool' }>;
    const reasoning = result[0].parts[1] as Extract<Part, { type: 'reasoning' }>;

    expect(tool.state.status === 'completed' && tool.state.output).toBe('big output');
    expect(reasoning.reasoning).toBe('deep thoughts');
  });

  it('compact mode prunes old tool outputs and reasoning', () => {
    const msgs = [
      makeMsg(makeAssistantMessage('msg1'), [makeToolPart('t1', 'completed', 'old output')]),
      makeMsg(makeAssistantMessage('msg2'), [makeToolPart('t2', 'completed', 'old output 2')]),
      makeMsg(makeAssistantMessage('msg3'), [
        makeToolPart('t3', 'completed', 'recent output'),
        makeReasoningPart('r1', 'my reasoning'),
      ]),
    ];
    const result = pruneMessages(msgs, { mode: 'compact', keepRecentToolResults: 1 });

    const t1 = result[0].parts[0] as Extract<Part, { type: 'tool' }>;
    const t2 = result[1].parts[0] as Extract<Part, { type: 'tool' }>;
    const t3 = result[2].parts[0] as Extract<Part, { type: 'tool' }>;
    const r1 = result[2].parts[1] as Extract<Part, { type: 'reasoning' }>;

    // t1 and t2 are outside the last-1 window — pruned
    expect(t1.state.status === 'completed' && t1.state.output).toBe(COMPACT_TOOL_PLACEHOLDER);
    expect(t2.state.status === 'completed' && t2.state.output).toBe(COMPACT_TOOL_PLACEHOLDER);
    // t3 is the most recent — kept
    expect(t3.state.status === 'completed' && t3.state.output).toBe('recent output');
    // reasoning always pruned in compact
    expect(r1.reasoning).toBe(COMPACT_REASONING_PLACEHOLDER);
  });

  it('compact mode with keepRecentToolResults=0 prunes all completed tool outputs', () => {
    const msgs = [
      makeMsg(makeAssistantMessage(), [
        makeToolPart('t1', 'completed', 'output a'),
        makeToolPart('t2', 'completed', 'output b'),
      ]),
    ];
    const result = pruneMessages(msgs, { mode: 'compact', keepRecentToolResults: 0 });

    for (const part of result[0].parts) {
      const tool = part as Extract<Part, { type: 'tool' }>;
      expect(tool.state.status === 'completed' && tool.state.output).toBe(COMPACT_TOOL_PLACEHOLDER);
    }
  });

  it('compact mode preserves message info unchanged', () => {
    const user = makeMsg(makeUserMessage(), [makeTextPart('p1', 'hi')]);
    const result = pruneMessages([user], { mode: 'compact', keepRecentToolResults: 5 });
    expect(result[0].info).toEqual(user.info);
    expect(result[0].parts[0]).toEqual(user.parts[0]);
  });

  it('compact mode does not modify user messages', () => {
    const msgs = [makeMsg(makeUserMessage(), [makeTextPart('p1', 'hello')])];
    const result = pruneMessages(msgs, { mode: 'compact', keepRecentToolResults: 5 });
    expect(result).toEqual(msgs);
  });
});

// ─── rewriteSessionPaths ──────────────────────────────────────────────────────

describe('rewriteSessionPaths', () => {
  it('is a no-op when source and local directories match', () => {
    const session = makeSession('/home/user/project');
    const msgs = [makeMsg(makeAssistantMessage('m1', '/home/user/project', '/home/user/project'))];

    const { session: s, messages: m } = rewriteSessionPaths(session, msgs, '/home/user/project');

    expect(s).toBe(session); // same reference — no copy made
    expect(m).toBe(msgs);
  });

  it('rewrites session.directory', () => {
    const session = makeSession('/Users/kush/ict_llm');
    const msgs: MessageExport[] = [];

    const { session: s } = rewriteSessionPaths(session, msgs, '/home/kush/ict_llm');
    expect(s.directory).toBe('/home/kush/ict_llm');
  });

  it('rewrites AssistantMessage path.cwd and path.root when they start with source dir', () => {
    const session = makeSession('/Users/kush/ict_llm');
    const msgs = [
      makeMsg(makeAssistantMessage('m1', '/Users/kush/ict_llm/src', '/Users/kush/ict_llm'), []),
    ];

    const { messages: m } = rewriteSessionPaths(session, msgs, '/home/kush/ict_llm');
    const am = m[0].info as AssistantMessage;

    expect(am.path.cwd).toBe('/home/kush/ict_llm/src');
    expect(am.path.root).toBe('/home/kush/ict_llm');
  });

  it('leaves paths unchanged when they do not start with source dir', () => {
    const session = makeSession('/Users/kush/ict_llm');
    const msgs = [makeMsg(makeAssistantMessage('m1', '/tmp/scratch', '/tmp'), [])];

    const { messages: m } = rewriteSessionPaths(session, msgs, '/home/kush/ict_llm');
    const am = m[0].info as AssistantMessage;

    expect(am.path.cwd).toBe('/tmp/scratch');
    expect(am.path.root).toBe('/tmp');
  });

  it('does not modify UserMessage (no path field)', () => {
    const session = makeSession('/Users/kush/ict_llm');
    const msgs = [makeMsg(makeUserMessage(), [])];

    const { messages: m } = rewriteSessionPaths(session, msgs, '/home/kush/ict_llm');

    expect(m[0].info).toEqual(msgs[0].info);
  });

  it('handles subdirectory paths correctly', () => {
    const session = makeSession('/Users/kush/ict_llm');
    const msgs = [
      makeMsg(
        makeAssistantMessage('m1', '/Users/kush/ict_llm/src/components/ui', '/Users/kush/ict_llm'),
        []
      ),
    ];

    const { messages: m } = rewriteSessionPaths(session, msgs, '/home/kush/projects/ict_llm');
    const am = m[0].info as AssistantMessage;

    expect(am.path.cwd).toBe('/home/kush/projects/ict_llm/src/components/ui');
    expect(am.path.root).toBe('/home/kush/projects/ict_llm');
  });

  it('preserves all other session fields unchanged', () => {
    const session = makeSession('/Users/kush/ict_llm');
    const { session: s } = rewriteSessionPaths(session, [], '/home/kush/ict_llm');

    expect(s.id).toBe(session.id);
    expect(s.title).toBe(session.title);
    expect(s.time).toEqual(session.time);
    expect(s.projectID).toBe(session.projectID);
  });

  it('handles mixed messages — rewrites assistant, skips user', () => {
    const session = makeSession('/Users/kush/ict_llm');
    const msgs = [
      makeMsg(makeUserMessage('u1'), []),
      makeMsg(makeAssistantMessage('a1', '/Users/kush/ict_llm/src', '/Users/kush/ict_llm'), []),
      makeMsg(makeUserMessage('u2'), []),
      makeMsg(makeAssistantMessage('a2', '/Users/kush/ict_llm/tests', '/Users/kush/ict_llm'), []),
    ];

    const { messages: m } = rewriteSessionPaths(session, msgs, '/home/kush/ict_llm');

    expect((m[0].info as UserMessage).id).toBe('u1');
    expect((m[1].info as AssistantMessage).path.cwd).toBe('/home/kush/ict_llm/src');
    expect((m[2].info as UserMessage).id).toBe('u2');
    expect((m[3].info as AssistantMessage).path.cwd).toBe('/home/kush/ict_llm/tests');
  });
});
