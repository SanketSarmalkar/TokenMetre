import { ModelUsage } from './sessionParser';

interface ModelRate {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const PRICING: Record<string, ModelRate> = {
  'claude-opus-4-7':   { input: 15,   output: 75,  cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-opus-4-5':   { input: 15,   output: 75,  cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-sonnet-4-6': { input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-sonnet-4-5': { input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-4-5':  { input: 0.80, output: 4,   cacheWrite: 1.00,  cacheRead: 0.08 },
  'claude-haiku-3-5':  { input: 0.80, output: 4,   cacheWrite: 1.00,  cacheRead: 0.08 },
};

export function modelPricing(model: string): ModelRate {
  if (PRICING[model]) return PRICING[model];
  if (model.includes('opus'))  return { input: 15,   output: 75,  cacheWrite: 18.75, cacheRead: 1.50 };
  if (model.includes('haiku')) return { input: 0.80, output: 4,   cacheWrite: 1.00,  cacheRead: 0.08 };
  return { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 };
}

export function calcCost(models: ModelUsage[]): number {
  return models.reduce((sum, m) => {
    const p = modelPricing(m.model);
    return sum + (
      m.inputTokens         * p.input      +
      m.outputTokens        * p.output     +
      m.cacheCreationTokens * p.cacheWrite +
      m.cacheReadTokens     * p.cacheRead
    ) / 1_000_000;
  }, 0);
}

export function fmtCost(c: number): string {
  if (c === 0)    return '$0.00';
  if (c < 0.001)  return `$${c.toFixed(5)}`;
  if (c < 0.01)   return `$${c.toFixed(4)}`;
  if (c < 1)      return `$${c.toFixed(3)}`;
  return `$${c.toFixed(2)}`;
}

export function calcModelSummaryCost(modelSummary: ModelUsage[]): number {
  return calcCost(modelSummary);
}
