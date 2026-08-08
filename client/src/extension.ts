// The extension host side: start the server, feed it the workspace, show the
// Parts view.
//
// Deliberately thin. Everything that understands manta lives in the server, so
// the same understanding can serve any editor that speaks the protocol.

import * as path from 'path';
import * as vscode from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';

import { PartsProvider } from './parts-view';

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const serverModule = context.asAbsolutePath(path.join('out', 'server', 'src', 'server.js'));

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: { execArgv: ['--nolazy', '--inspect=6019'] },
        },
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'manta' },
            { scheme: 'file', language: 'mantarules' },
        ],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.manta'),
        },
    };

    client = new LanguageClient('manta', 'Manta Language Server', serverOptions, clientOptions);
    await client.start();

    const parts = new PartsProvider(client);
    const view = vscode.window.createTreeView('mantaParts', {
        treeDataProvider: parts,
        showCollapseAll: true,
    });
    context.subscriptions.push(view);

    // The server has no filesystem of its own, so the client finds the files
    // and hands them over. Without this the index would cover open tabs only,
    // and a hover could not explain a part declared in a file nobody opened.
    const indexWorkspace = async () => {
        const exclude = vscode.workspace
            .getConfiguration('manta')
            .get<string[]>('index.exclude', ['**/node_modules/**', '**/build/**']);

        const uris = await vscode.workspace.findFiles('**/*.manta', `{${exclude.join(',')}}`);
        const files: { uri: string; text: string }[] = [];
        for (const uri of uris) {
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                files.push({ uri: uri.toString(), text: Buffer.from(bytes).toString('utf8') });
            } catch {
                // A file that cannot be read is simply not indexed. It will be
                // picked up if it becomes readable and changes.
            }
        }
        await client!.sendRequest('manta/indexFiles', { files });
        view.description = describeIndex(files.length);
    };

    client.onNotification('manta/indexChanged', () => void parts.refresh());

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.manta');
    context.subscriptions.push(
        watcher,
        watcher.onDidCreate(() => void indexWorkspace()),
        watcher.onDidDelete((uri) => void client!.sendRequest('manta/removeFile', { uri: uri.toString() })),
        watcher.onDidChange(async (uri) => {
            // An open document is already synchronised by the protocol; this is
            // for a file changed on disk behind the editor's back.
            if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString())) {
                return;
            }
            await indexWorkspace();
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('manta.refreshParts', async () => {
            await indexWorkspace();
            await parts.refresh();
        }),

        vscode.commands.registerCommand('manta.groupPartsBy', async () => {
            const picked = await vscode.window.showQuickPick(
                [
                    { label: 'By kind', description: 'parts, blocks, harnesses…', value: 'kind' },
                    { label: 'By file', description: 'grouped by where each is written', value: 'file' },
                    { label: 'Flat', description: 'one sorted list', value: 'flat' },
                ],
                { title: 'Group the Parts view by' },
            );
            if (!picked) return;
            await vscode.workspace
                .getConfiguration('manta')
                .update('parts.groupBy', picked.value, vscode.ConfigurationTarget.Workspace);
            await parts.refresh();
        }),

        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('manta.parts.groupBy')) void parts.refresh();
            if (event.affectsConfiguration('manta.index.exclude')) void indexWorkspace();
        }),
    );

    await indexWorkspace();
    await parts.refresh();
}

function describeIndex(files: number): string {
    if (files === 0) return 'no .manta files';
    return `${files} file${files === 1 ? '' : 's'}`;
}

export async function deactivate(): Promise<void> {
    await client?.stop();
    client = undefined;
}
