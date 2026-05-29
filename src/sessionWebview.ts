import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { parseSession, SessionReport, ModelUsage } from './sessionParser';
import { modelPricing, calcCost, fmtCost } from './pricing';
import { SessionItem } from './projectsProvider';
import { GroupLevel } from './aggregatesProvider';

export function openSessionWebview(context: vscode.ExtensionContext, item: SessionItem): void {
  const panel = vscode.window.createWebviewPanel(
    'claudeSessionTokens',
    `Tokens · ${item.sessionId.slice(0, 8)}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  try {
    const report = parseSession(item.filepath);
    const projectName = report.projectPath ? path.basename(report.projectPath) : item.sessionId.slice(0, 8);
    panel.title = `Tokens · ${projectName} · ${report.date}`;
    const nonce = crypto.randomBytes(16).toString('base64');
    panel.webview.html = buildHtml(report, nonce);

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'exportCsv') {
        const defaultName = `tokens-${report.sessionId.slice(0, 8)}-${report.date}.csv`;
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(report.projectPath || '', defaultName)),
          filters: { 'CSV Files': ['csv'] },
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, generateCsv(report), 'utf-8');
          vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
        }
      }
    }, undefined, context.subscriptions);
  } catch (e) {
    panel.webview.html = errorHtml(String(e));
  }
}


export function openPeriodWebview(context: vscode.ExtensionContext, period: string, level: GroupLevel): void {
  const levelLabel = level === 'daily' ? 'Day' : level === 'monthly' ? 'Month' : 'Year';
  const panel = vscode.window.createWebviewPanel(
    'claudePeriodTokens',
    `Tokens · ${period}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  try {
    const reports = findSessionsForPeriod(period);
    const nonce = crypto.randomBytes(16).toString('base64');
    panel.webview.html = buildPeriodHtml(reports, period, levelLabel, nonce);

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'exportCsv') {
        const defaultName = `tokens-${level}-${period}.csv`;
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultName)),
          filters: { 'CSV Files': ['csv'] },
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, generatePeriodCsv(reports, period), 'utf-8');
          vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
        }
      }
    }, undefined, context.subscriptions);
  } catch (e) {
    panel.webview.html = errorHtml(String(e));
  }
}

function findSessionsForPeriod(period: string): SessionReport[] {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return [];
  const reports: SessionReport[] = [];
  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsDir, entry.name);
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
      try {
        const report = parseSession(path.join(dir, file));
        if (report.date.startsWith(period)) reports.push(report);
      } catch { /* skip */ }
    }
  }
  return reports.sort((a, b) => a.date.localeCompare(b.date));
}

function generatePeriodCsv(reports: SessionReport[], period: string): string {
  const csvEsc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows = reports.map((r, i) => {
    const cost = calcCost(r.modelSummary);
    const tokens = r.totalInput + r.totalCacheCreation + r.totalCacheRead + r.totalOutput;
    return [i + 1, r.date, csvEsc(r.sessionId), csvEsc(path.basename(r.projectPath || r.sessionId)),
      r.turns.length, r.totalApiCalls, tokens, r.totalOutput, fmtCost(cost)].join(',');
  });
  const totalCost = reports.reduce((s, r) => s + calcCost(r.modelSummary), 0);
  const totalTokens = reports.reduce((s, r) => s + r.totalInput + r.totalCacheCreation + r.totalCacheRead + r.totalOutput, 0);
  const totalRow = ['', csvEsc('TOTAL'), '', '', reports.reduce((s, r) => s + r.turns.length, 0),
    reports.reduce((s, r) => s + r.totalApiCalls, 0), totalTokens,
    reports.reduce((s, r) => s + r.totalOutput, 0), fmtCost(totalCost)].join(',');

  // Aggregate model breakdown
  const globalModel = new Map<string, ModelUsage & { cost: number }>();
  for (const r of reports) {
    for (const m of r.modelSummary) {
      if (!globalModel.has(m.model)) globalModel.set(m.model, { ...m, cost: 0 });
      const g = globalModel.get(m.model)!;
      g.apiCalls += m.apiCalls; g.inputTokens += m.inputTokens; g.outputTokens += m.outputTokens;
      g.cacheCreationTokens += m.cacheCreationTokens; g.cacheReadTokens += m.cacheReadTokens;
      g.cost += calcCost([m]);
    }
  }
  const modelHeader = '\nModel Breakdown\nModel,API Calls,Input,Cache+,Cache~,Output,Est. Cost';
  const modelRows = Array.from(globalModel.values())
    .sort((a, b) => b.cost - a.cost)
    .map(m => [csvEsc(m.model), m.apiCalls, m.inputTokens, m.cacheCreationTokens, m.cacheReadTokens, m.outputTokens, fmtCost(m.cost)].join(','));

  return ['#,Date,Session ID,Project,Turns,API Calls,Total Tokens,Output Tokens,Est. Cost',
    ...rows, totalRow, modelHeader, ...modelRows].join('\n');
}

function buildPeriodHtml(reports: SessionReport[], period: string, levelLabel: string, nonce: string): string {
  const totalCost    = reports.reduce((s, r) => s + calcCost(r.modelSummary), 0);
  const totalTurns   = reports.reduce((s, r) => s + r.turns.length, 0);
  const totalCalls   = reports.reduce((s, r) => s + r.totalApiCalls, 0);
  const totalTokens  = reports.reduce((s, r) => s + r.totalInput + r.totalCacheCreation + r.totalCacheRead + r.totalOutput, 0);
  const totalOutput  = reports.reduce((s, r) => s + r.totalOutput, 0);

  // Aggregate model data
  const globalModel = new Map<string, ModelUsage & { cost: number }>();
  for (const r of reports) {
    for (const m of r.modelSummary) {
      if (!globalModel.has(m.model)) globalModel.set(m.model, { ...m, cost: 0 });
      const g = globalModel.get(m.model)!;
      g.apiCalls += m.apiCalls; g.inputTokens += m.inputTokens; g.outputTokens += m.outputTokens;
      g.cacheCreationTokens += m.cacheCreationTokens; g.cacheReadTokens += m.cacheReadTokens;
      g.cost += calcCost([m]);
    }
  }
  const modelRows = Array.from(globalModel.values())
    .sort((a, b) => b.cost - a.cost)
    .map(m => `
      <tr>
        <td>${esc(m.model)}</td>
        <td class="col-num">${m.apiCalls}</td>
        <td class="col-num col-input">${fmt(m.inputTokens)}</td>
        <td class="col-num col-cache-create">${fmt(m.cacheCreationTokens)}</td>
        <td class="col-num col-cache-read">${fmt(m.cacheReadTokens)}</td>
        <td class="col-num col-output">${fmt(m.outputTokens)}</td>
        <td class="col-num col-cost">${fmtCost(m.cost)}</td>
      </tr>`).join('');

  const sessionRows = reports.map((r, i) => {
    const cost   = calcCost(r.modelSummary);
    const tokens = r.totalInput + r.totalCacheCreation + r.totalCacheRead + r.totalOutput;
    const project = r.projectPath ? path.basename(r.projectPath) : '—';
    const chips = r.modelSummary.map(m =>
      `<span class="model-chip">${esc(shortModel(m.model))}<span class="chip-calls">×${m.apiCalls}</span></span>`
    ).join('');
    return `
      <tr>
        <td class="col-num">${i + 1}</td>
        <td>${esc(r.date)}</td>
        <td class="col-question">
          <div class="question-text">${esc(project)}</div>
          <div class="session-sub">${esc(r.sessionId.slice(0, 16))}</div>
          <div class="model-chips">${chips}</div>
        </td>
        <td class="col-num">${r.turns.length}</td>
        <td class="col-num">${r.totalApiCalls}</td>
        <td class="col-num col-input">${fmt(tokens)}</td>
        <td class="col-num col-output">${fmt(r.totalOutput)}</td>
        <td class="col-num col-cost">${fmtCost(cost)}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>${esc(period)} · ${esc(levelLabel)} Report</title>
  ${sharedStyles()}
  <style>
    .session-sub { font-size: 0.75em; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); }
  </style>
</head>
<body>
  <div class="header">
    <h1>${esc(period)} · ${esc(levelLabel)} Report</h1>
    <div class="session-id">${reports.length} session${reports.length !== 1 ? 's' : ''}</div>
  </div>

  <div class="summary-bar">
    <div class="summary-item"><span class="summary-label">Sessions</span><span class="summary-value">${reports.length}</span></div>
    <div class="summary-item"><span class="summary-label">Turns</span><span class="summary-value">${totalTurns}</span></div>
    <div class="summary-item"><span class="summary-label">API Calls</span><span class="summary-value">${totalCalls}</span></div>
    <div class="summary-item"><span class="summary-label">Total Tokens</span><span class="summary-value">${fmt(totalTokens)}</span></div>
    <div class="summary-item"><span class="summary-label">Output</span><span class="summary-value">${fmt(totalOutput)}</span></div>
    <div class="summary-item"><span class="summary-label">Est. Cost</span><span class="summary-value col-cost">${fmtCost(totalCost)}</span></div>
  </div>

  <div class="toolbar">
    <button class="btn-export" id="exportBtn">&#8681; Export CSV</button>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:30px">#</th>
        <th style="width:90px">Date</th>
        <th>Project / Session</th>
        <th class="col-num">Turns</th>
        <th class="col-num">Calls</th>
        <th class="col-num">Tokens</th>
        <th class="col-num">Output</th>
        <th class="col-num">Cost</th>
      </tr>
    </thead>
    <tbody>${sessionRows}</tbody>
    <tfoot>
      <tr>
        <td></td><td></td>
        <td>Total</td>
        <td class="col-num">${totalTurns}</td>
        <td class="col-num">${totalCalls}</td>
        <td class="col-num col-input">${fmt(totalTokens)}</td>
        <td class="col-num col-output">${fmt(totalOutput)}</td>
        <td class="col-num col-cost">${fmtCost(totalCost)}</td>
      </tr>
    </tfoot>
  </table>

  <div class="model-summary">
    <h2>Model Breakdown</h2>
    <table>
      <thead>
        <tr>
          <th>Model</th>
          <th class="col-num">Calls</th>
          <th class="col-num">Input</th>
          <th class="col-num">Cache+</th>
          <th class="col-num">Cache~</th>
          <th class="col-num">Output</th>
          <th class="col-num">Cost</th>
        </tr>
      </thead>
      <tbody>${modelRows}</tbody>
    </table>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    document.getElementById('exportBtn').addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'exportCsv' });
    });
  </script>
</body>
</html>`;
}

// "2026-05-29T10:34:22.000Z" → "2026-05-29 10:00"
function toHourBucket(ts: string): string {
  if (!ts) return 'Unknown';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return 'Unknown';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
}

function generateCsv(report: SessionReport): string {
  const totalEffective = report.totalInput + report.totalCacheCreation + report.totalCacheRead;
  const totalCost = report.turns.reduce((s, t) => s + calcCost(t.models), 0);
  const csvEsc = (s: string) => `"${s.replace(/"/g, '""')}"`;

  const header = '#,Timestamp,Question,API Calls,Input,Cache+,Cache~,Output,Effective Input,% Effective,Est. Cost';

  const rows = report.turns.map((t, i) => {
    const effective = t.inputTokens + t.cacheCreationTokens + t.cacheReadTokens;
    const pct = totalEffective > 0 ? (effective / totalEffective * 100).toFixed(1) : '0';
    return [
      i + 1,
      csvEsc(t.timestamp),
      csvEsc(t.question),
      t.apiCalls,
      t.inputTokens,
      t.cacheCreationTokens,
      t.cacheReadTokens,
      t.outputTokens,
      effective,
      `${pct}%`,
      fmtCost(calcCost(t.models)),
    ].join(',');
  });

  const totalRow = [
    '',
    '',
    csvEsc('TOTAL'),
    report.totalApiCalls,
    report.totalInput,
    report.totalCacheCreation,
    report.totalCacheRead,
    report.totalOutput,
    totalEffective,
    '100%',
    fmtCost(totalCost),
  ].join(',');

  // Hourly breakdown
  const hourMap = new Map<string, { turns: number; apiCalls: number; input: number; output: number; cost: number }>();
  for (const t of report.turns) {
    const h = toHourBucket(t.timestamp);
    if (!hourMap.has(h)) hourMap.set(h, { turns: 0, apiCalls: 0, input: 0, output: 0, cost: 0 });
    const b = hourMap.get(h)!;
    b.turns++;
    b.apiCalls += t.apiCalls;
    b.input    += t.inputTokens + t.cacheCreationTokens + t.cacheReadTokens;
    b.output   += t.outputTokens;
    b.cost     += calcCost(t.models);
  }
  const hourHeader = '\nHourly Breakdown\nHour,Turns,API Calls,Effective Input,Output,Est. Cost';
  const hourRows = Array.from(hourMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([h, v]) => [csvEsc(h), v.turns, v.apiCalls, v.input, v.output, fmtCost(v.cost)].join(','));

  const modelHeader = '\nModel Breakdown\nModel,API Calls,Input,Cache+,Cache~,Output,Est. Cost';
  const modelRows = report.modelSummary.map(m => {
    const p = modelPricing(m.model);
    const cost = (m.inputTokens * p.input + m.outputTokens * p.output +
      m.cacheCreationTokens * p.cacheWrite + m.cacheReadTokens * p.cacheRead) / 1_000_000;
    return [csvEsc(m.model), m.apiCalls, m.inputTokens, m.cacheCreationTokens, m.cacheReadTokens, m.outputTokens, fmtCost(cost)].join(',');
  });

  return [header, ...rows, totalRow, hourHeader, ...hourRows, modelHeader, ...modelRows].join('\n');
}

// "claude-sonnet-4-6" → "sonnet-4-6"
function shortModel(model: string): string {
  return model.replace(/^claude-/, '');
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sharedStyles(): string {
  return `<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
    }
    .header { margin-bottom: 20px; }
    .header h1 { font-size: 1.2em; font-weight: 600; color: var(--vscode-foreground); margin-bottom: 4px; }
    .project-path { font-size: 0.85em; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); }
    .session-id { font-size: 0.8em; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); margin-top: 2px; }
    .summary-bar {
      display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 20px;
      padding: 12px 14px; background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px; border-left: 3px solid var(--vscode-focusBorder, #007acc);
    }
    .summary-item { display: flex; flex-direction: column; gap: 2px; }
    .summary-label { font-size: 0.75em; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.05em; }
    .summary-value { font-size: 1.1em; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; font-size: 0.92em; }
    thead th {
      text-align: left; padding: 8px 10px; font-size: 0.8em; text-transform: uppercase;
      letter-spacing: 0.05em; color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); white-space: nowrap;
    }
    thead th.col-num { text-align: right; }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    tbody tr + tr { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.1)); }
    td { padding: 10px 10px; vertical-align: top; }
    .col-num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .col-question { width: 99%; }
    .question-text { word-break: break-word; white-space: pre-wrap; line-height: 1.5; }
    .bar-track { margin-top: 6px; height: 3px; background: var(--vscode-panel-border, rgba(128,128,128,0.2)); border-radius: 2px; overflow: hidden; }
    .bar-fill { height: 100%; background: var(--vscode-focusBorder, #007acc); border-radius: 2px; min-width: 2px; }
    .col-input        { color: var(--vscode-charts-blue,    #4fc3f7); }
    .col-cache-create { color: var(--vscode-charts-orange,  #ffb74d); }
    .col-cache-read   { color: var(--vscode-charts-green,   #81c784); }
    .col-output       { color: var(--vscode-charts-purple,  #ce93d8); }
    .col-pct          { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    .col-cost         { color: var(--vscode-charts-yellow,  #ffd54f); white-space: nowrap; }
    .turn-ts { font-size: 0.75em; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); margin-bottom: 3px; }
    tfoot td { padding: 10px 10px; font-weight: 600; border-top: 2px solid var(--vscode-panel-border, rgba(128,128,128,0.4)); white-space: nowrap; }
    tfoot .col-num { text-align: right; }
    .legend { margin-top: 16px; display: flex; gap: 20px; flex-wrap: wrap; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
    .legend-item { display: flex; align-items: center; gap: 5px; }
    .legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .toolbar { display: flex; justify-content: flex-end; margin-bottom: 12px; }
    .btn-export {
      display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; font-size: 0.85em;
      font-family: var(--vscode-font-family); color: var(--vscode-button-foreground);
      background: var(--vscode-button-background); border: none; border-radius: 3px; cursor: pointer;
    }
    .btn-export:hover { background: var(--vscode-button-hoverBackground); }
    .model-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .model-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; font-size: 0.75em; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
    .model-chip .chip-calls { opacity: 0.75; }
    .model-summary, .hourly-breakdown { margin-top: 24px; }
    .model-summary h2, .hourly-breakdown h2 { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin-bottom: 10px; }
    .model-summary table, .hourly-breakdown table { font-size: 0.9em; }
  </style>`;
}

function buildHtml(report: SessionReport, nonce: string): string {
  const totalEffective = report.totalInput + report.totalCacheCreation + report.totalCacheRead;
  const totalCost = report.turns.reduce((s, t) => s + calcCost(t.models), 0);

  const rows = report.turns.map((t, i) => {
    const effective = t.inputTokens + t.cacheCreationTokens + t.cacheReadTokens;
    const pct = totalEffective > 0 ? (effective / totalEffective * 100) : 0;
    const barWidth = Math.max(1, Math.round(pct));
    const cost = calcCost(t.models);
    const chips = t.models.map(m =>
      `<span class="model-chip">${esc(shortModel(m.model))}<span class="chip-calls">×${m.apiCalls}</span></span>`
    ).join('');
    const tsLabel = t.timestamp ? `<div class="turn-ts">${esc(t.timestamp.replace('T', ' ').slice(0, 16))}</div>` : '';

    return `
      <tr>
        <td class="col-num">${i + 1}</td>
        <td class="col-question">
          ${tsLabel}
          <div class="question-text">${esc(t.question)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${barWidth}%"></div></div>
          <div class="model-chips">${chips}</div>
        </td>
        <td class="col-num">${t.apiCalls}</td>
        <td class="col-num col-input">${fmt(t.inputTokens)}</td>
        <td class="col-num col-cache-create">${fmt(t.cacheCreationTokens)}</td>
        <td class="col-num col-cache-read">${fmt(t.cacheReadTokens)}</td>
        <td class="col-num col-output">${fmt(t.outputTokens)}</td>
        <td class="col-num col-pct">${pct.toFixed(1)}%</td>
        <td class="col-num col-cost">${fmtCost(cost)}</td>
      </tr>`;
  }).join('');

  // Hourly breakdown data
  const hourMap = new Map<string, { turns: number; apiCalls: number; input: number; output: number; cost: number }>();
  for (const t of report.turns) {
    const h = toHourBucket(t.timestamp);
    if (!hourMap.has(h)) hourMap.set(h, { turns: 0, apiCalls: 0, input: 0, output: 0, cost: 0 });
    const b = hourMap.get(h)!;
    b.turns++;
    b.apiCalls += t.apiCalls;
    b.input    += t.inputTokens + t.cacheCreationTokens + t.cacheReadTokens;
    b.output   += t.outputTokens;
    b.cost     += calcCost(t.models);
  }
  const hourRows = Array.from(hourMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([h, v]) => `
      <tr>
        <td>${esc(h)}</td>
        <td class="col-num">${v.turns}</td>
        <td class="col-num">${v.apiCalls}</td>
        <td class="col-num col-input">${fmt(v.input)}</td>
        <td class="col-num col-output">${fmt(v.output)}</td>
        <td class="col-num col-cost">${fmtCost(v.cost)}</td>
      </tr>`).join('');

  const projectLabel = report.projectPath
    ? `<span class="project-path">${esc(report.projectPath)}</span>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">

  <title>Session Tokens</title>
  ${sharedStyles()}
</head>
<body>
  <div class="header">
    <h1>${esc(report.date ? `${report.date} Session` : 'Session Report')}</h1>
    ${projectLabel}
    <div class="session-id">${esc(report.sessionId)}</div>
  </div>

  <div class="summary-bar">
    <div class="summary-item">
      <span class="summary-label">Questions</span>
      <span class="summary-value">${report.turns.length}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">API Calls</span>
      <span class="summary-value">${report.totalApiCalls}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">Effective Input</span>
      <span class="summary-value">${fmt(totalEffective)}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">Output</span>
      <span class="summary-value">${fmt(report.totalOutput)}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">Cache Reads</span>
      <span class="summary-value">${fmt(report.totalCacheRead)}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">Est. Cost</span>
      <span class="summary-value col-cost">${fmtCost(totalCost)}</span>
    </div>
  </div>

  <div class="toolbar">
    <button class="btn-export" id="exportBtn">&#8681; Export CSV</button>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:30px">#</th>
        <th>Question</th>
        <th class="col-num">Calls</th>
        <th class="col-num">Input</th>
        <th class="col-num">Cache+</th>
        <th class="col-num">Cache~</th>
        <th class="col-num">Output</th>
        <th class="col-num">% Eff</th>
        <th class="col-num">Cost</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td></td>
        <td>Total</td>
        <td class="col-num">${report.totalApiCalls}</td>
        <td class="col-num col-input">${fmt(report.totalInput)}</td>
        <td class="col-num col-cache-create">${fmt(report.totalCacheCreation)}</td>
        <td class="col-num col-cache-read">${fmt(report.totalCacheRead)}</td>
        <td class="col-num col-output">${fmt(report.totalOutput)}</td>
        <td class="col-num">100%</td>
        <td class="col-num col-cost">${fmtCost(totalCost)}</td>
      </tr>
    </tfoot>
  </table>

  <div class="legend">
    <div class="legend-item">
      <div class="legend-dot" style="background:var(--vscode-charts-blue,#4fc3f7)"></div>
      Input — fresh uncached tokens
    </div>
    <div class="legend-item">
      <div class="legend-dot" style="background:var(--vscode-charts-orange,#ffb74d)"></div>
      Cache+ — tokens written to cache
    </div>
    <div class="legend-item">
      <div class="legend-dot" style="background:var(--vscode-charts-green,#81c784)"></div>
      Cache~ — tokens read from cache
    </div>
    <div class="legend-item">
      <div class="legend-dot" style="background:var(--vscode-charts-purple,#ce93d8)"></div>
      Output — generated tokens
    </div>
  </div>
  <div class="hourly-breakdown">
    <h2>Hourly Breakdown</h2>
    <table>
      <thead>
        <tr>
          <th>Hour</th>
          <th class="col-num">Turns</th>
          <th class="col-num">API Calls</th>
          <th class="col-num">Eff. Input</th>
          <th class="col-num">Output</th>
          <th class="col-num">Cost</th>
        </tr>
      </thead>
      <tbody>${hourRows}</tbody>
    </table>
  </div>

  <div class="model-summary">
    <h2>Model Breakdown</h2>
    <table>
      <thead>
        <tr>
          <th>Model</th>
          <th class="col-num">Calls</th>
          <th class="col-num">Input</th>
          <th class="col-num">Cache+</th>
          <th class="col-num">Cache~</th>
          <th class="col-num">Output</th>
          <th class="col-num">Cost</th>
        </tr>
      </thead>
      <tbody>
        ${report.modelSummary.map(m => {
          const p = modelPricing(m.model);
          const cost = (m.inputTokens * p.input + m.outputTokens * p.output +
            m.cacheCreationTokens * p.cacheWrite + m.cacheReadTokens * p.cacheRead) / 1_000_000;
          return `
        <tr>
          <td>${esc(m.model)}</td>
          <td class="col-num">${m.apiCalls}</td>
          <td class="col-num col-input">${fmt(m.inputTokens)}</td>
          <td class="col-num col-cache-create">${fmt(m.cacheCreationTokens)}</td>
          <td class="col-num col-cache-read">${fmt(m.cacheReadTokens)}</td>
          <td class="col-num col-output">${fmt(m.outputTokens)}</td>
          <td class="col-num col-cost">${fmtCost(cost)}</td>
        </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    document.getElementById('exportBtn').addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'exportCsv' });
    });
  </script>
</body>
</html>`;
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html><html><body style="padding:20px;font-family:sans-serif">
    <h3 style="color:red">Error parsing session</h3>
    <pre>${esc(message)}</pre>
  </body></html>`;
}
