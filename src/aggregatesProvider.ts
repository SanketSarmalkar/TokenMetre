import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseSession, ModelUsage } from './sessionParser';
import { modelPricing, fmtCost } from './pricing';

interface ModelAggStat {
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

interface AggStat {
  sessions: number;
  apiCalls: number;
  totalTokens: number;
  cost: number;
  modelMap: Map<string, ModelAggStat>;
}

export type GroupLevel = 'daily' | 'monthly' | 'yearly';

function fmtTok(t: number): string {
  if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(2)}M`;
  if (t >= 1_000)     return `${(t / 1_000).toFixed(1)}K`;
  return String(t);
}

function modelCost(m: ModelUsage): number {
  const p = modelPricing(m.model);
  return (
    m.inputTokens         * p.input      +
    m.outputTokens        * p.output     +
    m.cacheCreationTokens * p.cacheWrite +
    m.cacheReadTokens     * p.cacheRead
  ) / 1_000_000;
}

export class GroupItem extends vscode.TreeItem {
  constructor(public readonly level: GroupLevel, label: string, count: number) {
    super(`${label}  (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'aggregateGroup';
  }
}

export class PeriodItem extends vscode.TreeItem {
  constructor(
    public readonly period: string,
    public readonly level: GroupLevel,
    stat: AggStat,
  ) {
    super(period, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${stat.sessions} sess · ${fmtTok(stat.totalTokens)} tok · ${fmtCost(stat.cost)}`;
    this.tooltip = new vscode.MarkdownString(
      `**${period}**\n\nSessions: ${stat.sessions}\nAPI calls: ${stat.apiCalls}\n` +
      `Tokens: ${stat.totalTokens.toLocaleString()}\nEst. cost: ${fmtCost(stat.cost)}`
    );
    this.command = {
      command: 'claudeTokens.openPeriod',
      title: 'Open Period Report',
      arguments: [this],
    };
    this.contextValue = 'aggregatePeriod';
  }
}

export class ModelAggItem extends vscode.TreeItem {
  constructor(model: string, stat: ModelAggStat) {
    super(model.replace(/^claude-/, ''), vscode.TreeItemCollapsibleState.None);
    const t = stat.inputTokens + stat.cacheCreationTokens + stat.cacheReadTokens + stat.outputTokens;
    this.description = `×${stat.apiCalls} · ${fmtTok(t)} tok · ${fmtCost(stat.cost)}`;
    this.tooltip = new vscode.MarkdownString(
      `**${model}**\n\nAPI calls: ${stat.apiCalls}\n` +
      `Input: ${stat.inputTokens.toLocaleString()}\nCache+: ${stat.cacheCreationTokens.toLocaleString()}\n` +
      `Cache~: ${stat.cacheReadTokens.toLocaleString()}\nOutput: ${stat.outputTokens.toLocaleString()}\n` +
      `Est. cost: ${fmtCost(stat.cost)}`
    );
    this.contextValue = 'aggregateModel';
  }
}

type AnyItem = GroupItem | PeriodItem | ModelAggItem;

export class AggregatesProvider implements vscode.TreeDataProvider<AnyItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private daily   = new Map<string, AggStat>();
  private monthly = new Map<string, AggStat>();
  private yearly  = new Map<string, AggStat>();
  private loaded  = false;

  refresh(): void {
    this.loaded = false;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: AnyItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: AnyItem): Promise<AnyItem[]> {
    if (!element) {
      if (!this.loaded) await this.loadAll();
      return [
        new GroupItem('daily',   'Daily',   this.daily.size),
        new GroupItem('monthly', 'Monthly', this.monthly.size),
        new GroupItem('yearly',  'Yearly',  this.yearly.size),
      ];
    }

    if (element instanceof GroupItem) {
      const map = element.level === 'daily'  ? this.daily
               : element.level === 'monthly' ? this.monthly
               : this.yearly;
      return Array.from(map.entries())
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([period, stat]) => new PeriodItem(period, element.level, stat));
    }

    if (element instanceof PeriodItem) {
      const map = element.level === 'daily'  ? this.daily
               : element.level === 'monthly' ? this.monthly
               : this.yearly;
      const stat = map.get(element.period);
      if (!stat) return [];
      return Array.from(stat.modelMap.entries())
        .sort(([, a], [, b]) => b.cost - a.cost)
        .map(([model, ms]) => new ModelAggItem(model, ms));
    }

    return [];
  }

  private async loadAll(): Promise<void> {
    this.daily.clear();
    this.monthly.clear();
    this.yearly.clear();

    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) { this.loaded = true; return; }

    const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(projectsDir, d.name));

    for (const dir of projectDirs) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        try {
          const report = parseSession(path.join(dir, file));
          if (!report.date) continue;

          const totalTokens = report.totalInput + report.totalCacheCreation +
                              report.totalCacheRead + report.totalOutput;

          // Pre-compute per-model costs once for this session
          const modelEntries = report.modelSummary.map(m => ({ m, cost: modelCost(m) }));
          const sessionCost  = modelEntries.reduce((s, e) => s + e.cost, 0);

          const day   = report.date;
          const month = report.date.slice(0, 7);
          const year  = report.date.slice(0, 4);

          for (const [map, key] of [
            [this.daily,   day  ] as const,
            [this.monthly, month] as const,
            [this.yearly,  year ] as const,
          ]) {
            if (!map.has(key)) {
              map.set(key, { sessions: 0, apiCalls: 0, totalTokens: 0, cost: 0, modelMap: new Map() });
            }
            const bucket = map.get(key)!;
            bucket.sessions++;
            bucket.apiCalls    += report.totalApiCalls;
            bucket.totalTokens += totalTokens;
            bucket.cost        += sessionCost;

            for (const { m, cost } of modelEntries) {
              if (!bucket.modelMap.has(m.model)) {
                bucket.modelMap.set(m.model, {
                  apiCalls: 0, inputTokens: 0, outputTokens: 0,
                  cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0,
                });
              }
              const ms = bucket.modelMap.get(m.model)!;
              ms.apiCalls            += m.apiCalls;
              ms.inputTokens         += m.inputTokens;
              ms.outputTokens        += m.outputTokens;
              ms.cacheCreationTokens += m.cacheCreationTokens;
              ms.cacheReadTokens     += m.cacheReadTokens;
              ms.cost                += cost;
            }
          }
        } catch { /* skip unparseable session files */ }
      }
    }

    this.loaded = true;
  }
}
