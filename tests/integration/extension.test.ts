// The extension, running inside a real VS Code.
//
// This is the suite that can see what the others cannot: that the extension
// activates at all, that the language server starts under the extension host's
// IPC transport rather than the stdio one the unit tests use, that the Parts
// tree renders, and that a hover comes back through the editor's own provider
// pipeline. Everything here goes through the public `vscode` API, so a pass
// means the feature works for a user, not just for a test harness.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';

import type { MantaApi } from '../../client/src/extension';
import type { PartsEntry } from '../../client/src/parts-view';

const EXTENSION_ID = 'manta.manta-vscode';

let api: MantaApi;
let workspace: vscode.Uri;

function uriFor(name: string): vscode.Uri {
    return vscode.Uri.file(join(workspace.fsPath, name));
}

/** Retries until `f` returns something truthy, or the budget runs out. */
async function eventually<T>(
    what: string,
    f: () => T | undefined | Promise<T | undefined>,
    ms = 20_000,
): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = await f();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 200));
    }
}

/** The declarations the Parts view is showing, whatever the grouping. */
function treeEntries(): PartsEntry[] {
    const roots = api.parts.getChildren();
    const out: PartsEntry[] = [];
    for (const node of roots) {
        if (node.type === 'entry') out.push(node.entry);
        else for (const child of api.parts.getChildren(node)) {
            if (child.type === 'entry') out.push(child.entry);
        }
    }
    return out;
}

suite('Manta extension', function () {
    // Activation downloads nothing but does spawn a server process, and the
    // first index reads the workspace.
    this.timeout(60_000);

    suiteSetup(async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'the test workspace did not open');
        workspace = folder.uri;

        const extension = vscode.extensions.getExtension<MantaApi>(EXTENSION_ID);
        assert.ok(extension, `${EXTENSION_ID} is not installed in this VS Code`);

        api = await extension.activate();
        await eventually('the workspace index', () => treeEntries().length > 0);
    });

    // -----------------------------------------------------------------------
    // Activation
    // -----------------------------------------------------------------------

    test('activates on a workspace containing .manta files, with nothing opened', () => {
        const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
        assert.equal(extension.isActive, true);
        assert.equal(vscode.window.activeTextEditor, undefined, 'a file was opened after all');
    });

    test('a .manta file is recognised as manta', async () => {
        const document = await vscode.workspace.openTextDocument(uriFor('parts.manta'));
        assert.equal(document.languageId, 'manta');
    });

    test('the grammars are contributed to the languages they claim', () => {
        const contributed = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes;
        const languages: string[] = contributed.grammars.map((g: { language: string }) => g.language);
        assert.deepEqual(languages.sort(), ['manta', 'mantarules']);
    });

    // -----------------------------------------------------------------------
    // The Parts view
    // -----------------------------------------------------------------------

    test('the Parts view lists declarations from every file, opened or not', () => {
        const names = treeEntries().map((e) => e.name);

        // Nothing has been opened but the first document, and board.manta was
        // never touched. Both files must still be indexed.
        assert.ok(names.includes('MCU-48'), `MCU-48 missing from ${JSON.stringify(names)}`);
        assert.ok(names.includes('board'), `board missing from ${JSON.stringify(names)}`);
        assert.ok(names.includes('R-pullup-4k7'));
        assert.ok(names.includes('i2c-bus'));
    });

    test('documentation below the end-of-content marker is not listed as code', () => {
        // parts.manta's datasheet contains "block not-a-block {".
        assert.ok(!treeEntries().some((e) => e.name === 'not-a-block'));
    });

    test('a tree item carries a label, a detail and an icon', () => {
        const node = api.parts
            .getChildren()
            .flatMap((n) => (n.type === 'group' ? api.parts.getChildren(n) : [n]))
            .find((n) => n.type === 'entry' && n.entry.name === 'MCU-48');
        assert.ok(node);

        const item = api.parts.getTreeItem(node);
        assert.equal(item.label, 'MCU-48');
        assert.match(String(item.description), /52 pins/);
        assert.ok(item.iconPath instanceof vscode.ThemeIcon);
        assert.equal(item.command?.command, 'vscode.open');
    });

    test('a tree item resolves a hover card on demand', async () => {
        const node = api.parts
            .getChildren()
            .flatMap((n) => (n.type === 'group' ? api.parts.getChildren(n) : [n]))
            .find((n) => n.type === 'entry' && n.entry.name === 'MCU-48')!;

        const source = new vscode.CancellationTokenSource();
        const resolved = await api.parts.resolveTreeItem(
            api.parts.getTreeItem(node),
            node,
            source.token,
        );
        source.dispose();

        const tooltip = resolved.tooltip as vscode.MarkdownString | undefined;
        assert.ok(tooltip, 'no tooltip was resolved');
        assert.match(tooltip.value, /STM32F0QA5/);
    });

    test('grouping by kind puts parts and blocks in separate groups', async () => {
        await vscode.workspace
            .getConfiguration('manta')
            .update('parts.groupBy', 'kind', vscode.ConfigurationTarget.Workspace);

        const groups = api.parts.getChildren().filter((n) => n.type === 'group');
        const labels = groups.map((g) => (g.type === 'group' ? g.label : ''));
        assert.ok(labels.some((l) => l.startsWith('Parts')), JSON.stringify(labels));
        assert.ok(labels.some((l) => l.startsWith('Blocks')), JSON.stringify(labels));
    });

    test('grouping flat gives one ungrouped list', async () => {
        await vscode.workspace
            .getConfiguration('manta')
            .update('parts.groupBy', 'flat', vscode.ConfigurationTarget.Workspace);

        const roots = api.parts.getChildren();
        assert.ok(roots.length > 0);
        assert.ok(roots.every((n) => n.type === 'entry'), 'flat grouping produced groups');

        await vscode.workspace
            .getConfiguration('manta')
            .update('parts.groupBy', undefined, vscode.ConfigurationTarget.Workspace);
    });

    test('the refresh command runs', async () => {
        await vscode.commands.executeCommand('manta.refreshParts');
        assert.ok(treeEntries().length > 0, 'the index emptied on refresh');
    });

    test('both commands are registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('manta.refreshParts'));
        assert.ok(commands.includes('manta.groupPartsBy'));
    });

    // -----------------------------------------------------------------------
    // Hover, through the editor's own provider pipeline
    // -----------------------------------------------------------------------

    test('hovering a part name gives its card', async () => {
        const document = await vscode.workspace.openTextDocument(uriFor('parts.manta'));
        await vscode.window.showTextDocument(document);

        const line = lineContaining(document, 'part MCU-48 {');
        const position = new vscode.Position(line, document.lineAt(line).text.indexOf('MCU-48') + 1);

        const hovers = await eventually('a hover', async () =>
            firstNonEmpty(
                await vscode.commands.executeCommand<vscode.Hover[]>(
                    'vscode.executeHoverProvider',
                    document.uri,
                    position,
                ),
            ),
        );

        const text = hoverText(hovers);
        assert.match(text, /LQFP-48/, 'the footprint is missing');
        assert.match(text, /STM32F0QA5/, 'the value is missing');
        assert.match(text, /52 pins/, 'the pin count is missing');
        assert.match(text, /A microcontroller/, 'the doc comment is missing');
    });

    test('hovering an instantiation in another file explains the part', async () => {
        // board.manta writes `{U2~MCU-48: …}` and does not declare MCU-48. This
        // is the case that only works because the index is workspace-wide.
        const document = await vscode.workspace.openTextDocument(uriFor('board.manta'));
        await vscode.window.showTextDocument(document);

        const line = lineContaining(document, 'U2~MCU-48');
        const position = new vscode.Position(line, document.lineAt(line).text.indexOf('MCU-48') + 1);

        const hovers = await eventually('a cross-file hover', async () =>
            firstNonEmpty(
                await vscode.commands.executeCommand<vscode.Hover[]>(
                    'vscode.executeHoverProvider',
                    document.uri,
                    position,
                ),
            ),
        );
        assert.match(hoverText(hovers), /STM32F0QA5/);
    });

    test('hovering inside the datasheet gives nothing', async () => {
        const document = await vscode.workspace.openTextDocument(uriFor('parts.manta'));
        const line = lineContaining(document, 'block not-a-block');
        const position = new vscode.Position(line, 2);

        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            document.uri,
            position,
        );
        assert.equal(hoverText(hovers ?? []).trim(), '');
    });

    // -----------------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------------

    test('go to definition crosses files', async () => {
        const document = await vscode.workspace.openTextDocument(uriFor('board.manta'));
        const line = lineContaining(document, 'U2~MCU-48');
        const position = new vscode.Position(line, document.lineAt(line).text.indexOf('MCU-48') + 1);

        const locations = await eventually('a definition', async () =>
            firstNonEmpty(
                await vscode.commands.executeCommand<vscode.Location[]>(
                    'vscode.executeDefinitionProvider',
                    document.uri,
                    position,
                ),
            ),
        );

        assert.equal(locations[0].uri.fsPath, uriFor('parts.manta').fsPath);
    });

    test('document symbols list the declarations in a file', async () => {
        const document = await vscode.workspace.openTextDocument(uriFor('parts.manta'));
        const symbols = await eventually('document symbols', async () =>
            firstNonEmpty(
                await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                    'vscode.executeDocumentSymbolProvider',
                    document.uri,
                ),
            ),
        );

        const names = symbols.map((s) => s.name);
        assert.ok(names.includes('MCU-48'), JSON.stringify(names));
        assert.ok(names.includes('top'));
        assert.ok(!names.includes('not-a-block'));
    });

    test('workspace symbols answer a partial name', async () => {
        const symbols = await eventually('workspace symbols', async () =>
            firstNonEmpty(
                await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                    'vscode.executeWorkspaceSymbolProvider',
                    'pullup',
                ),
            ),
        );
        assert.ok(symbols.some((s) => s.name === 'R-pullup-4k7'));
    });

    // -----------------------------------------------------------------------
    // Editing
    // -----------------------------------------------------------------------

    test('editing a file updates the index', async () => {
        const document = await vscode.workspace.openTextDocument(uriFor('board.manta'));
        const editor = await vscode.window.showTextDocument(document);

        await editor.edit((edit) => {
            edit.insert(
                new vscode.Position(document.lineCount, 0),
                '\nblock added-while-typing {\n    A = B;\n};\n',
            );
        });

        await eventually('the new block to appear', () =>
            treeEntries().some((e) => e.name === 'added-while-typing'),
        );

        // Leave the fixture as it was found; the file is never saved, so the
        // revert only has to undo the in-memory edit.
        await vscode.commands.executeCommand('workbench.action.files.revert');
    });
});

// ---------------------------------------------------------------------------

function lineContaining(document: vscode.TextDocument, needle: string): number {
    for (let i = 0; i < document.lineCount; i++) {
        if (document.lineAt(i).text.includes(needle)) return i;
    }
    throw new Error(`${document.uri.fsPath} has no line containing ${JSON.stringify(needle)}`);
}

function firstNonEmpty<T>(values: T[] | undefined): T[] | undefined {
    return values && values.length > 0 ? values : undefined;
}

function hoverText(hovers: vscode.Hover[]): string {
    return hovers
        .flatMap((h) => h.contents)
        .map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))
        .join('\n');
}
