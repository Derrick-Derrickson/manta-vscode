// SPDX-FileCopyrightText: 2026 Tom
// SPDX-License-Identifier: GPL-3.0-or-later
// Inline SVG symbols for the inline schematic: proper drawn parts, sized in
// character cells so they sit naturally in a monospace line. A resistor is
// the IEC box, five cells wide, with its value set inside; a capacitor is two
// plates; an inductor is humps; a diode a triangle and bar. Rendered as data
// URIs for decoration contentIconPath -- no files, no network.

import * as vscode from 'vscode';

export interface SymbolTheme {
    /** Symbol strokes and value text. */
    stroke: string;
    /** The short wire leads either side, matching the wire lines. */
    wire: string;
}

export function themeFor(kind: vscode.ColorThemeKind): SymbolTheme {
    const dark = kind === vscode.ColorThemeKind.Dark
        || kind === vscode.ColorThemeKind.HighContrast;
    return dark
        ? { stroke: '#9db8f0', wire: '#6f9fff96' }
        : { stroke: '#2f54ad', wire: '#3a6fd896' };
}

/** Monospace advance for the editor font size; VS Code's default families
 *  all land close to 0.6em. */
export const cellWidth = (fontSize: number) => Math.round(fontSize * 0.6);

function svgUri(width: number, height: number, body: string): vscode.Uri {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" ` +
        `height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
    return vscode.Uri.parse(
        `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function textEl(x: number, y: number, size: number, fill: string, text: string,
                maxWidth?: number): string {
    const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fit = maxWidth !== undefined && text.length * size * 0.62 > maxWidth
        ? ` textLength="${maxWidth}" lengthAdjust="spacingAndGlyphs"` : '';
    return `<text x="${x}" y="${y}" font-family="monospace" font-size="${size}" ` +
        `fill="${fill}" text-anchor="middle" dominant-baseline="central"${fit}>${esc}</text>`;
}

/**
 * Builds the symbol image for one device. Height is one line's worth; the
 * conductor sits at mid-height so the wire strike-through lines meet it.
 */
export function deviceIcon(kind: string, value: string, fontSize: number,
                           theme: SymbolTheme): { uri: vscode.Uri; } {
    const ch = cellWidth(fontSize);
    const h = Math.round(fontSize * 1.3);
    const cy = h / 2;
    const sw = Math.max(1.2, fontSize / 12);
    const stroke = `stroke="${theme.stroke}" stroke-width="${sw}" fill="none"`;
    const lead = (x1: number, x2: number) =>
        `<line x1="${x1}" y1="${cy}" x2="${x2}" y2="${cy}" stroke="${theme.wire}" ` +
        `stroke-width="${sw}"/>`;
    const valueSize = Math.round(fontSize * 0.78);

    switch (kind) {
        case 'resistor': {
            // IEC box, five cells, value inside.
            const w = 5 * ch;
            const boxX = Math.round(0.4 * ch);
            const boxW = w - 2 * boxX;
            const boxH = Math.round(h * 0.72);
            const boxY = cy - boxH / 2;
            const body = lead(0, boxX) + lead(w - boxX, w) +
                `<rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" ` +
                `rx="1.5" ${stroke}/>` +
                (value ? textEl(w / 2, cy, valueSize, theme.stroke, value, boxW - 4) : '');
            return { uri: svgUri(w, h, body) };
        }
        case 'inductor': {
            // Four humps across five cells, value beside.
            const humps = 4;
            const coilW = 5 * ch - Math.round(0.8 * ch);
            const x0 = Math.round(0.4 * ch);
            const r = coilW / (2 * humps);
            let d = `M ${x0} ${cy}`;
            for (let k = 0; k < humps; k++) d += ` a ${r} ${r * 1.4} 0 0 1 ${2 * r} 0`;
            const textW = value ? Math.round(value.length * valueSize * 0.62) + 4 : 0;
            const w = 5 * ch + textW;
            const body = lead(0, x0) + lead(x0 + coilW, 5 * ch) +
                `<path d="${d}" ${stroke}/>` +
                (value ? textEl(5 * ch + textW / 2, cy, valueSize, theme.stroke, value) : '');
            return { uri: svgUri(w, h, body) };
        }
        case 'capacitor': {
            // Two plates, value beside.
            const symW = 3 * ch;
            const gap = Math.max(3, Math.round(ch * 0.35));
            const p1 = symW / 2 - gap / 2;
            const p2 = symW / 2 + gap / 2;
            const plateH = Math.round(h * 0.7);
            const textW = value ? Math.round(value.length * valueSize * 0.62) + 4 : 0;
            const w = symW + textW;
            const body = lead(0, p1) + lead(p2, symW) +
                `<line x1="${p1}" y1="${cy - plateH / 2}" x2="${p1}" y2="${cy + plateH / 2}" ${stroke}/>` +
                `<line x1="${p2}" y1="${cy - plateH / 2}" x2="${p2}" y2="${cy + plateH / 2}" ${stroke}/>` +
                (value ? textEl(symW + textW / 2, cy, valueSize, theme.stroke, value) : '');
            return { uri: svgUri(w, h, body) };
        }
        case 'diode':
        case 'led': {
            const symW = 3 * ch;
            const triW = Math.round(1.2 * ch);
            const x0 = symW / 2 - triW / 2;
            const x1 = symW / 2 + triW / 2;
            const half = Math.round(h * 0.3);
            const textW = value ? Math.round(value.length * valueSize * 0.62) + 4 : 0;
            const w = symW + textW;
            let body = lead(0, x0) + lead(x1, symW) +
                `<path d="M ${x0} ${cy - half} L ${x1} ${cy} L ${x0} ${cy + half} Z" ` +
                `stroke="${theme.stroke}" stroke-width="${sw}" fill="${theme.stroke}22"/>` +
                `<line x1="${x1}" y1="${cy - half}" x2="${x1}" y2="${cy + half}" ${stroke}/>`;
            if (kind === 'led') {
                const ax = x0 + triW * 0.25;
                body += `<path d="M ${ax} ${cy - half - 1} l 3 -3 m -3 0 l 3 0 m 0 0 l 0 3" ` +
                    `${stroke} transform="rotate(-15 ${ax} ${cy - half - 1})"/>`;
            }
            if (value) body += textEl(symW + textW / 2, cy, valueSize, theme.stroke, value);
            return { uri: svgUri(w, h, body) };
        }
        default: {
            const w = 2 * ch;
            return { uri: svgUri(w, h, lead(0, w)) };
        }
    }
}
