// The Parts view.
//
// A tree view is a VS Code idea with no equivalent in the language protocol, so
// the client renders it -- but the server still decides what is in it, over one
// custom request. Keeping one index means the tree and a hover can never
// disagree about what a part is.

import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

export type DeclKind = 'part' | 'block' | 'harness' | 'netclass' | 'match';

export interface PartsEntry {
    name: string;
    kind: DeclKind;
    isStatic: boolean;
    detail: string;
    uri: string;
    range: vscode.Range;
    selectionRange: vscode.Range;
    pinCount: number;
    instantiations: number;
}

type GroupBy = 'kind' | 'file' | 'flat';

const KIND_ORDER: DeclKind[] = ['part', 'block', 'harness', 'netclass', 'match'];

const KIND_PLURAL: Record<DeclKind, string> = {
    part: 'Parts',
    block: 'Blocks',
    harness: 'Harnesses',
    netclass: 'Net classes',
    match: 'Match groups',
};

const KIND_ICON: Record<DeclKind, string> = {
    part: 'symbol-class',
    block: 'symbol-module',
    harness: 'symbol-interface',
    netclass: 'symbol-namespace',
    match: 'symbol-event',
};

/** A group header, or a declaration. */
export type Node = { type: 'group'; label: string; children: PartsEntry[] } | { type: 'entry'; entry: PartsEntry };

export class PartsProvider implements vscode.TreeDataProvider<Node> {
    private readonly changed = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.changed.event;

    private entries: PartsEntry[] = [];
    private loadFailed = false;

    constructor(private readonly client: LanguageClient) {}

    async refresh(): Promise<void> {
        try {
            const raw = await this.client.sendRequest<PartsEntry[]>('manta/parts');
            this.entries = raw.map((e) => ({
                ...e,
                range: toRange(e.range),
                selectionRange: toRange(e.selectionRange),
            }));
            this.loadFailed = false;
        } catch {
            // The server may not be up yet during activation. An empty tree is
            // the honest state; a thrown error would surface as a scary popup
            // for something that resolves itself a moment later.
            this.entries = [];
            this.loadFailed = true;
        }
        this.changed.fire(undefined);
    }

    private get groupBy(): GroupBy {
        return vscode.workspace.getConfiguration('manta').get<GroupBy>('parts.groupBy', 'kind');
    }

    getChildren(node?: Node): Node[] {
        if (node) {
            return node.type === 'group' ? node.children.map((entry) => ({ type: 'entry', entry })) : [];
        }

        if (this.entries.length === 0) return [];

        switch (this.groupBy) {
            case 'flat':
                return this.entries.map((entry) => ({ type: 'entry', entry }));

            case 'file': {
                const byFile = new Map<string, PartsEntry[]>();
                for (const entry of this.entries) {
                    const list = byFile.get(entry.uri) ?? [];
                    list.push(entry);
                    byFile.set(entry.uri, list);
                }
                return [...byFile.entries()]
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([uri, children]) => ({
                        type: 'group' as const,
                        label: vscode.workspace.asRelativePath(vscode.Uri.parse(uri)),
                        children,
                    }));
            }

            case 'kind':
            default: {
                const byKind = new Map<DeclKind, PartsEntry[]>();
                for (const entry of this.entries) {
                    const list = byKind.get(entry.kind) ?? [];
                    list.push(entry);
                    byKind.set(entry.kind, list);
                }
                return KIND_ORDER.filter((k) => byKind.has(k)).map((kind) => ({
                    type: 'group' as const,
                    label: `${KIND_PLURAL[kind]} (${byKind.get(kind)!.length})`,
                    children: byKind.get(kind)!,
                }));
            }
        }
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.type === 'group') {
            const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
            item.contextValue = 'mantaGroup';
            return item;
        }

        const { entry } = node;
        const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
        item.description = entry.detail;
        item.iconPath = new vscode.ThemeIcon(KIND_ICON[entry.kind]);
        item.contextValue = `manta.${entry.kind}`;
        item.resourceUri = vscode.Uri.parse(entry.uri);

        // The tooltip is filled in lazily by resolveTreeItem, so building the
        // tree does not mean rendering a card for every declaration up front.
        item.command = {
            command: 'vscode.open',
            title: 'Open',
            arguments: [
                vscode.Uri.parse(entry.uri),
                { selection: entry.selectionRange } satisfies vscode.TextDocumentShowOptions,
            ],
        };
        return item;
    }

    async resolveTreeItem(
        item: vscode.TreeItem,
        node: Node,
        token: vscode.CancellationToken,
    ): Promise<vscode.TreeItem> {
        if (node.type !== 'entry' || token.isCancellationRequested) return item;
        try {
            const markdown = await this.client.sendRequest<string | null>(
                'manta/describe',
                { name: node.entry.name },
            );
            if (markdown) {
                const tooltip = new vscode.MarkdownString(markdown);
                tooltip.supportThemeIcons = true;
                item.tooltip = tooltip;
            }
        } catch {
            // A tooltip is a nicety; failing to build one is not worth a report.
        }
        return item;
    }

    /** Shown in the view when there is nothing to show. */
    get emptyMessage(): string {
        if (this.loadFailed) return 'The manta language server is still starting.';
        return 'No manta declarations found in this workspace.';
    }
}

function toRange(r: {
    start: { line: number; character: number };
    end: { line: number; character: number };
}): vscode.Range {
    return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}
