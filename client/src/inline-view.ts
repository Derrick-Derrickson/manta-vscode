// SPDX-FileCopyrightText: 2026 Tom
// SPDX-License-Identifier: GPL-3.0-or-later
// The inline schematic: editor decorations that make a chain read like the
// circuit it describes. Wires as faint lines -- under the gap for '=', up and
// over the hopped part for '==' -- part references collapsed to a symbol and
// value, and ground / rail glyphs on the nets that are one.
//
// All understanding lives in the server ('manta/inline'); this file only
// turns spans into decorations. Lines the cursor sits on are left undecorated
// so the source is always editable as written.

import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

interface InlineSpan {
    line: number;
    start: number;
    end: number;
}

interface InlineFacts {
    devices: { hide: InlineSpan; text: string }[];
    joins: { span: InlineSpan; over: boolean }[];
    marks: { span: InlineSpan; kind: 'ground' | 'rail' }[];
}

const toRange = (s: InlineSpan) => new vscode.Range(s.line, s.start, s.line, s.end);

export class InlineSchematic {
    private readonly wireUnder: vscode.TextEditorDecorationType;
    private readonly wireOver: vscode.TextEditorDecorationType;
    private readonly device: vscode.TextEditorDecorationType;
    private readonly ground: vscode.TextEditorDecorationType;
    private readonly rail: vscode.TextEditorDecorationType;
    private readonly disposables: vscode.Disposable[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly client: LanguageClient) {
        const wire = new vscode.ThemeColor('manta.wire');
        const glyph = new vscode.ThemeColor('manta.glyph');
        this.wireUnder = vscode.window.createTextEditorDecorationType({
            borderStyle: 'solid',
            borderColor: wire,
            borderWidth: '0 0 1px 0',
        });
        this.wireOver = vscode.window.createTextEditorDecorationType({
            borderStyle: 'solid',
            borderColor: wire,
            borderWidth: '1px 0 0 0',
        });
        // The '~PART' span collapses; the symbol and value stand in its place.
        this.device = vscode.window.createTextEditorDecorationType({
            textDecoration: 'none; display: none;',
        });
        this.ground = vscode.window.createTextEditorDecorationType({
            after: { contentText: '⏚', color: glyph, margin: '0 0 0 0.15em' },
        });
        this.rail = vscode.window.createTextEditorDecorationType({
            after: { contentText: '↥', color: glyph, margin: '0 0 0 0.1em' },
        });

        this.disposables.push(
            this.wireUnder, this.wireOver, this.device, this.ground, this.rail,
            vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
            vscode.window.onDidChangeTextEditorSelection((e) => {
                if (e.textEditor.document.languageId === 'manta') this.schedule(50);
            }),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.languageId === 'manta') this.schedule();
            }),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('manta.inline')) this.schedule(0);
            }),
        );
        this.schedule(0);
    }

    dispose(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        for (const d of this.disposables) d.dispose();
    }

    private schedule(delay = 200): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), delay);
    }

    private async refresh(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'manta') return;

        const config = vscode.workspace.getConfiguration('manta.inline');
        const wantWires = config.get<boolean>('wires', true);
        const wantSymbols = config.get<boolean>('symbols', true);
        const wantMarks = config.get<boolean>('marks', true);

        let facts: InlineFacts | null = null;
        if (wantWires || wantSymbols || wantMarks) {
            try {
                facts = await this.client.sendRequest<InlineFacts | null>('manta/inline', {
                    uri: editor.document.uri.toString(),
                });
            } catch {
                facts = null;
            }
        }
        if (!facts) {
            for (const t of [this.wireUnder, this.wireOver, this.device, this.ground, this.rail]) {
                editor.setDecorations(t, []);
            }
            return;
        }

        // Lines the cursor touches show the source as written.
        const cursorLines = new Set<number>();
        for (const sel of editor.selections) {
            for (let l = sel.start.line; l <= sel.end.line; l++) cursorLines.add(l);
        }
        const visible = (s: InlineSpan) => !cursorLines.has(s.line);

        editor.setDecorations(
            this.wireUnder,
            wantWires ? facts.joins.filter((j) => !j.over && visible(j.span))
                                    .map((j) => toRange(j.span)) : [],
        );
        editor.setDecorations(
            this.wireOver,
            wantWires ? facts.joins.filter((j) => j.over && visible(j.span))
                                   .map((j) => toRange(j.span)) : [],
        );
        editor.setDecorations(
            this.device,
            wantSymbols
                ? facts.devices.filter((d) => visible(d.hide)).map((d) => ({
                      range: toRange(d.hide),
                      renderOptions: {
                          before: {
                              contentText: ` ${d.text}`,
                              color: new vscode.ThemeColor('manta.glyph'),
                          },
                      },
                  }))
                : [],
        );
        editor.setDecorations(
            this.ground,
            wantMarks ? facts.marks.filter((m) => m.kind === 'ground' && visible(m.span))
                                   .map((m) => toRange(m.span)) : [],
        );
        editor.setDecorations(
            this.rail,
            wantMarks ? facts.marks.filter((m) => m.kind === 'rail' && visible(m.span))
                                   .map((m) => toRange(m.span)) : [],
        );
    }
}
