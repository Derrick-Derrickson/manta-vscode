// SPDX-FileCopyrightText: 2026 Tom
// SPDX-License-Identifier: GPL-3.0-or-later
// Launches a real VS Code under Xvfb, opens the showcase workspace with the
// development extension, and lets capture.ts photograph the result. Not a
// test: a darkroom.

import { runTests } from '@vscode/test-electron';
import { existsSync } from 'fs';
import { resolve } from 'path';

function systemVSCode(): string | undefined {
    const candidates = [
        '/usr/share/code/code',
        '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    ];
    return candidates.find(existsSync);
}

async function main(): Promise<void> {
    const root = resolve(__dirname, '..', '..', '..');
    const executable = systemVSCode();
    try {
        await runTests({
            ...(executable ? { vscodeExecutablePath: executable } : {}),
            extensionDevelopmentPath: root,
            extensionTestsPath: resolve(__dirname, 'index'),
            launchArgs: [
                resolve(root, 'tests', 'shots', 'workspace'),
                '--disable-extensions',
                '--disable-gpu',
                '--disable-workspace-trust',
                `--user-data-dir=${resolve(root, '.vscode-test', 'shot-data')}`,
            ],
        });
    } catch (error) {
        console.error('shot run failed:', error);
        process.exit(1);
    }
}

void main();
