// SPDX-FileCopyrightText: 2026 Tom
// SPDX-License-Identifier: GPL-3.0-or-later
// Runs inside the extension host: open the showcase, wait for the inline
// schematic to settle, photograph the X root window.

import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import * as vscode from 'vscode';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(): Promise<void> {
    const out = resolve(__dirname, '..', '..', '..', 'tests', 'shots', 'out');
    mkdirSync(out, { recursive: true });

    const config = vscode.workspace.getConfiguration();
    await config.update('workbench.colorTheme', 'Default Dark Modern',
                        vscode.ConfigurationTarget.Global);
    await config.update('editor.minimap.enabled', false, vscode.ConfigurationTarget.Global);
    await config.update('editor.fontSize', 15, vscode.ConfigurationTarget.Global);
    await config.update('workbench.activityBar.location', 'hidden',
                        vscode.ConfigurationTarget.Global);

    const files = await vscode.workspace.findFiles('demo.manta');
    if (files.length === 0) throw new Error('demo.manta not found');
    const doc = await vscode.workspace.openTextDocument(files[0]);
    const editor = await vscode.window.showTextDocument(doc);
    // Park the cursor on line 0 so nothing else is revealed as source.
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    editor.revealRange(new vscode.Range(doc.lineCount - 1, 0, doc.lineCount - 1, 0));

    // The language server needs to start, index and answer manta/inline.
    await sleep(9000);
    execSync(`import -window root ${resolve(out, 'dark.png')}`);

    // A second frame from the top of the file catches the earlier lines.
    editor.revealRange(new vscode.Range(0, 0, 0, 0),
                       vscode.TextEditorRevealType.AtTop);
    await sleep(1500);
    execSync(`import -window root ${resolve(out, 'dark-top.png')}`);
    editor.revealRange(new vscode.Range(26, 0, 26, 0),
                       vscode.TextEditorRevealType.AtTop);
    await sleep(1500);
    execSync(`import -window root ${resolve(out, 'dark-mid.png')}`);

    await config.update('workbench.colorTheme', 'Default Light Modern',
                        vscode.ConfigurationTarget.Global);
    await sleep(3000);
    execSync(`import -window root ${resolve(out, 'light-top.png')}`);
    editor.revealRange(new vscode.Range(doc.lineCount - 1, 0, doc.lineCount - 1, 0));
    await sleep(1500);
    execSync(`import -window root ${resolve(out, 'light.png')}`);

    await config.update('workbench.colorTheme', 'Default Dark Modern',
                        vscode.ConfigurationTarget.Global);
}
