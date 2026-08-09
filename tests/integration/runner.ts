// SPDX-FileCopyrightText: 2026 Tom
// SPDX-License-Identifier: GPL-3.0-or-later
// Downloads (or reuses) a VS Code build, installs this extension into a throw-
// away profile, and runs the integration suite inside it.
//
// The workspace it opens holds .manta files and nothing else, which is what
// makes the activation test meaningful: the extension has to wake on
// workspaceContains, not because a file was opened for it.

import { runTests } from '@vscode/test-electron';
import { existsSync } from 'fs';
import { resolve } from 'path';

/**
 * The Electron binary of a system VS Code, if one is installed.
 *
 * Reusing it means the suite runs against the editor actually on the machine,
 * rather than a second copy pinned to whatever version the test harness feels
 * like fetching. Falling back to a download keeps this working on a machine
 * with no VS Code at all.
 */
function systemVSCode(): string | undefined {
    const candidates = [
        '/usr/share/code/code',
        '/usr/share/code-insiders/code-insiders',
        '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    ];
    return candidates.find(existsSync);
}

async function main(): Promise<void> {
    const root = resolve(__dirname, '..', '..', '..');
    const executable = systemVSCode();
    console.log(executable ? `using ${executable}` : 'downloading a VS Code build');

    try {
        await runTests({
            ...(executable ? { vscodeExecutablePath: executable } : {}),
            extensionDevelopmentPath: root,
            extensionTestsPath: resolve(__dirname, 'index'),
            launchArgs: [
                resolve(root, 'tests', 'integration', 'workspace'),
                // A shared profile would let a stale setting or another
                // extension decide the result.
                '--disable-extensions',
                '--disable-gpu',
                '--disable-workspace-trust',
                `--user-data-dir=${resolve(root, '.vscode-test', 'user-data')}`,
            ],
        });
    } catch (error) {
        console.error('integration tests failed:', error);
        process.exit(1);
    }
}

void main();
