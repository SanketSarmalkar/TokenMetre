import * as fs from 'fs';

interface ContentItem {
  type: string;
  text?: string;
  tool_use_id?: string;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface Entry {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isMeta?: boolean;
  timestamp?: string;
  cwd?: string;
  message?: {
    id?: string;
    model?: string;
    content?: string | ContentItem[];
    usage?: Usage;
  };
}

export interface ModelUsage {
  model: string;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface TurnUsage {
  question: string;
  timestamp: string;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  models: ModelUsage[];
}

export interface SessionReport {
  sessionId: string;
  projectPath: string;
  date: string;
  turns: TurnUsage[];
  totalApiCalls: number;
  totalInput: number;
  totalOutput: number;
  totalCacheCreation: number;
  totalCacheRead: number;
  modelSummary: ModelUsage[];
}

function isToolResult(entry: Entry): boolean {
  const content = entry.message?.content;
  if (Array.isArray(content)) {
    return content.some(c => c.type === 'tool_result');
  }
  return false;
}

function getText(entry: Entry): string {
  const content = entry.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text!)
      .join(' ')
      .trim();
  }
  return '';
}

function getQuestionLabel(entry: Entry): string {
  const text = getText(entry);
  const cmdMatch = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmdMatch) {
    const cmd = cmdMatch[1].trim();
    const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    if (argsMatch) {
      return `${cmd} ${argsMatch[1].trim()}`;
    }
    return cmd;
  }
  if (text.includes('This session is being continued')) {
    return '[context continuation]';
  }
  return text.replace(/\n/g, ' ') || '[empty]';
}

export function parseSession(filepath: string): SessionReport {
  const lines = fs.readFileSync(filepath, 'utf-8').split('\n');
  const entries: Entry[] = [];
  let cwd = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Entry;
      entries.push(entry);
      if (!cwd && entry.cwd) cwd = entry.cwd;
    } catch { /* skip malformed lines */ }
  }

  const byUuid = new Map<string, Entry>();
  for (const e of entries) {
    if (e.uuid) byUuid.set(e.uuid, e);
  }

  const humanTurns = new Map<string, string>();
  const humanTimestamps = new Map<string, string>();
  const turnOrder: string[] = [];

  for (const e of entries) {
    if (e.type !== 'user' || e.isMeta || isToolResult(e) || !e.uuid) continue;
    humanTurns.set(e.uuid, getQuestionLabel(e));
    if (e.timestamp) humanTimestamps.set(e.uuid, e.timestamp);
    turnOrder.push(e.uuid);
  }

  const ancestorCache = new Map<string, string | null>();

  function findHumanAncestor(uuid: string | null | undefined, depth = 0): string | null {
    if (!uuid || depth > 60) return null;
    const cached = ancestorCache.get(uuid);
    if (cached !== undefined) return cached;
    if (humanTurns.has(uuid)) {
      ancestorCache.set(uuid, uuid);
      return uuid;
    }
    const entry = byUuid.get(uuid);
    if (!entry) {
      ancestorCache.set(uuid, null);
      return null;
    }
    const result = findHumanAncestor(entry.parentUuid, depth + 1);
    ancestorCache.set(uuid, result);
    return result;
  }

  interface Bucket {
    inputTokens: number; outputTokens: number;
    cacheCreationTokens: number; cacheReadTokens: number;
    apiCalls: number; seenMsgIds: Set<string>;
    modelMap: Map<string, Omit<ModelUsage, 'model'>>;
  }

  const turnUsage = new Map<string, Bucket>();

  function getBucket(key: string): Bucket {
    if (!turnUsage.has(key)) {
      turnUsage.set(key, {
        inputTokens: 0, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0,
        apiCalls: 0, seenMsgIds: new Set(), modelMap: new Map(),
      });
    }
    return turnUsage.get(key)!;
  }

  for (const e of entries) {
    if (e.type !== 'assistant') continue;
    const usage = e.message?.usage;
    if (!usage) continue;
    const msgId = e.message?.id;
    const model = e.message?.model ?? 'unknown';
    const ancestor = findHumanAncestor(e.parentUuid);
    const key = ancestor ?? '__orphan__';
    const bucket = getBucket(key);
    if (msgId && bucket.seenMsgIds.has(msgId)) continue;
    if (msgId) bucket.seenMsgIds.add(msgId);

    const input   = usage.input_tokens ?? 0;
    const output  = usage.output_tokens ?? 0;
    const cCreate = usage.cache_creation_input_tokens ?? 0;
    const cRead   = usage.cache_read_input_tokens ?? 0;

    bucket.inputTokens         += input;
    bucket.outputTokens        += output;
    bucket.cacheCreationTokens += cCreate;
    bucket.cacheReadTokens     += cRead;
    bucket.apiCalls            += 1;

    if (!bucket.modelMap.has(model)) {
      bucket.modelMap.set(model, { apiCalls: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
    }
    const mb = bucket.modelMap.get(model)!;
    mb.apiCalls            += 1;
    mb.inputTokens         += input;
    mb.outputTokens        += output;
    mb.cacheCreationTokens += cCreate;
    mb.cacheReadTokens     += cRead;
  }

  const turns: TurnUsage[] = turnOrder
    .filter(uid => turnUsage.has(uid))
    .map(uid => {
      const u = turnUsage.get(uid)!;
      return {
        question: humanTurns.get(uid)!,
        timestamp: humanTimestamps.get(uid) ?? '',
        apiCalls: u.apiCalls,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheCreationTokens: u.cacheCreationTokens,
        cacheReadTokens: u.cacheReadTokens,
        models: Array.from(u.modelMap.entries())
          .map(([model, mu]) => ({ model, ...mu }))
          .sort((a, b) => b.apiCalls - a.apiCalls),
      };
    });

  const totals = turns.reduce(
    (acc, t) => ({
      totalApiCalls: acc.totalApiCalls + t.apiCalls,
      totalInput: acc.totalInput + t.inputTokens,
      totalOutput: acc.totalOutput + t.outputTokens,
      totalCacheCreation: acc.totalCacheCreation + t.cacheCreationTokens,
      totalCacheRead: acc.totalCacheRead + t.cacheReadTokens,
    }),
    { totalApiCalls: 0, totalInput: 0, totalOutput: 0, totalCacheCreation: 0, totalCacheRead: 0 }
  );

  // Aggregate model summary across all turns
  const globalModelMap = new Map<string, Omit<ModelUsage, 'model'>>();
  for (const t of turns) {
    for (const mu of t.models) {
      if (!globalModelMap.has(mu.model)) {
        globalModelMap.set(mu.model, { apiCalls: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
      }
      const g = globalModelMap.get(mu.model)!;
      g.apiCalls            += mu.apiCalls;
      g.inputTokens         += mu.inputTokens;
      g.outputTokens        += mu.outputTokens;
      g.cacheCreationTokens += mu.cacheCreationTokens;
      g.cacheReadTokens     += mu.cacheReadTokens;
    }
  }
  const modelSummary: ModelUsage[] = Array.from(globalModelMap.entries())
    .map(([model, mu]) => ({ model, ...mu }))
    .sort((a, b) => b.apiCalls - a.apiCalls);

  const sessionId = filepath.split('/').pop()!.replace('.jsonl', '');
  const date = entries.find(e => e.timestamp)?.timestamp?.slice(0, 10) ?? '';

  return { sessionId, projectPath: cwd, date, turns, ...totals, modelSummary };
}
