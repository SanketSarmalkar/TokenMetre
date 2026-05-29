import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

type AnyTreeItem = ProjectItem | SessionItem;

export class ProjectsProvider implements vscode.TreeDataProvider<AnyTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AnyTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: AnyTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AnyTreeItem): AnyTreeItem[] {
    if (!element) return this.getProjects();
    if (element instanceof ProjectItem) return this.getSessions(element.projectDir);
    return [];
  }

  private getProjects(): ProjectItem[] {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return [];

    return fs.readdirSync(projectsDir)
      .filter(name => {
        try {
          return fs.statSync(path.join(projectsDir, name)).isDirectory();
        } catch { return false; }
      })
      .map(name => {
        const dir = path.join(projectsDir, name);
        const cwd = this.getCwdFromProject(dir);
        return new ProjectItem(name, cwd, dir);
      })
      .filter(p => p.hasSessions())
      .sort((a, b) => a.label!.toString().localeCompare(b.label!.toString()));
  }

  private getCwdFromProject(dir: string): string {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
      if (files.length === 0) return '';
      const firstLines = fs.readFileSync(path.join(dir, files[0]), 'utf-8').split('\n').slice(0, 20);
      for (const line of firstLines) {
        try {
          const obj = JSON.parse(line) as { cwd?: string };
          if (obj.cwd) return obj.cwd;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return '';
  }

  private getSessions(projectDir: string): SessionItem[] {
    try {
      return fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const filepath = path.join(projectDir, f);
          const sessionId = f.replace('.jsonl', '');
          const date = this.getSessionDate(filepath);
          return new SessionItem(sessionId, date, filepath);
        })
        .sort((a, b) => b.date.localeCompare(a.date));
    } catch {
      return [];
    }
  }

  private getSessionDate(filepath: string): string {
    try {
      const firstLines = fs.readFileSync(filepath, 'utf-8').split('\n').slice(0, 10);
      for (const line of firstLines) {
        try {
          const obj = JSON.parse(line) as { timestamp?: string };
          if (obj.timestamp) return obj.timestamp.slice(0, 10);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return '';
  }
}

export class ProjectItem extends vscode.TreeItem {
  constructor(
    public readonly folderName: string,
    public readonly cwd: string,
    public readonly projectDir: string,
  ) {
    const displayName = cwd ? path.basename(cwd) : folderName;
    super(displayName, vscode.TreeItemCollapsibleState.Collapsed);
    this.tooltip = cwd || folderName;
    this.description = cwd ? path.dirname(cwd).replace(os.homedir(), '~') : '';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'project';
  }

  hasSessions(): boolean {
    try {
      return fs.readdirSync(this.projectDir).some(f => f.endsWith('.jsonl'));
    } catch {
      return false;
    }
  }
}

export class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly sessionId: string,
    public readonly date: string,
    public readonly filepath: string,
  ) {
    super(date || sessionId.slice(0, 8), vscode.TreeItemCollapsibleState.None);
    this.description = sessionId.slice(0, 8);
    this.tooltip = sessionId;
    this.iconPath = new vscode.ThemeIcon('graph');
    this.contextValue = 'session';
    this.command = {
      command: 'claudeTokens.openSession',
      title: 'Open Session Report',
      arguments: [this],
    };
  }
}
