import * as vscode from 'vscode';
import { ProjectsProvider, SessionItem } from './projectsProvider';
import { AggregatesProvider, PeriodItem } from './aggregatesProvider';
import { openSessionWebview, openPeriodWebview } from './sessionWebview';

export function activate(context: vscode.ExtensionContext): void {
  const sessionsProvider = new ProjectsProvider();
  const aggregatesProvider = new AggregatesProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('claudeTokens.sessions', sessionsProvider),
    vscode.window.registerTreeDataProvider('claudeTokens.aggregates', aggregatesProvider),

    vscode.commands.registerCommand('claudeTokens.refresh', () => {
      sessionsProvider.refresh();
      aggregatesProvider.refresh();
    }),

    vscode.commands.registerCommand('claudeTokens.openSession', (item: SessionItem) => {
      openSessionWebview(context, item);
    }),

    vscode.commands.registerCommand('claudeTokens.openPeriod', (item: PeriodItem) => {
      openPeriodWebview(context, item.period, item.level);
    })
  );
}

export function deactivate(): void { /* nothing to clean up */ }
