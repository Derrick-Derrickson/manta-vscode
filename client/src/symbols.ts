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
    /** Softer ink for values and net names. */
    label: string;
    /** The instance pin box. */
    boxFill: string;
    boxStroke: string;
}

export function themeFor(kind: vscode.ColorThemeKind): SymbolTheme {
    const dark = kind === vscode.ColorThemeKind.Dark
        || kind === vscode.ColorThemeKind.HighContrast;
    return dark
        ? { stroke: '#9db8f0', wire: '#6f9fff96', label: '#9db8f0c8',
            boxFill: '#d4b10620', boxStroke: '#d9b40cb0' }
        : { stroke: '#2f54ad', wire: '#3a6fd896', label: '#2f54adc8',
            boxFill: '#b5890014', boxStroke: '#8a6d03b0' };
}

/** Monospace advance for the editor font size; VS Code's default families
 *  all land close to 0.6em. */
export const cellWidth = (fontSize: number) => Math.round(fontSize * 0.6);

/** How far the icon is lowered below the baseline (vertical-align), so the
 *  wire crosses the canvas near its middle instead of its bottom. */
export const iconDrop = (fontSize: number) => Math.round(fontSize * 0.47);

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

/** A ruled target for calibrating the icon box against the text line:
 *  border magenta; rules every 4px -- red at 0/20/40..., green at 4/24...,
 *  yellow 8, cyan 12, white 16 (repeating). */
export function calibrationIcon(fontSize: number): vscode.Uri {
    const w = Math.round(fontSize * 4);
    const h = Math.round(fontSize * 1.8);
    const colors = ['#ff3333', '#33cc33', '#dddd22', '#22cccc', '#ffffff'];
    let body = `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" ` +
        `stroke="#ff00ff" stroke-width="1" fill="none"/>`;
    for (let y = 4, k = 1; y < h - 1; y += 4, k++) {
        body += `<line x1="1" y1="${y}" x2="${w - 1}" y2="${y}" ` +
            `stroke="${colors[k % colors.length]}" stroke-width="1"/>`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
        `viewBox="0 0 ${w} ${h}">${body}</svg>`;
    return vscode.Uri.parse(
        `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

interface Canvas { h: number; cy: number; sw: number; ch: number; }
function canvasFor(fontSize: number): Canvas {
    const h = Math.round(fontSize * 1.8);
    return {
        h,
        cy: Math.round(h - fontSize * 0.30) - iconDrop(fontSize),
        sw: Math.max(1.2, fontSize / 12),
        ch: cellWidth(fontSize),
    };
}

/** The bare symbol body, drawn about (cx, cy); returns its half-width. */
function symbolBody(kind: string, cx: number, cy: number, fontSize: number,
                    theme: SymbolTheme, sw: number): { body: string; halfW: number } {
    const stroke = `stroke="${theme.stroke}" stroke-width="${sw}" fill="none"`;
    const ch = cellWidth(fontSize);
    switch (kind) {
        case 'resistor': {
            const bw = Math.round(4.2 * ch);
            const bh = Math.round(fontSize * 0.75);
            return { halfW: bw / 2, body:
                `<rect x="${cx - bw / 2}" y="${cy - bh / 2}" width="${bw}" ` +
                `height="${bh}" rx="1.5" ${stroke}/>` };
        }
        case 'inductor': {
            const humps = 4;
            const rr = Math.round(2.1 * ch) / humps;
            const rise = Math.min(rr * 1.6, fontSize * 0.7);
            let d = `M ${cx - rr * humps} ${cy}`;
            for (let k = 0; k < humps; k++) d += ` a ${rr} ${rise} 0 0 1 ${2 * rr} 0`;
            return { halfW: rr * humps, body: `<path d="${d}" ${stroke}/>` };
        }
        case 'capacitor': {
            const gap = Math.max(4, Math.round(ch * 0.5));
            const up = Math.round(fontSize * 0.55);
            return { halfW: gap / 2 + sw, body:
                `<line x1="${cx - gap / 2}" y1="${cy - up}" x2="${cx - gap / 2}" y2="${cy + up}" ${stroke}/>` +
                `<line x1="${cx + gap / 2}" y1="${cy - up}" x2="${cx + gap / 2}" y2="${cy + up}" ${stroke}/>` };
        }
        default: {  // diode / led
            const half = Math.round(fontSize * 0.42);
            const triW = Math.round(1.2 * ch);
            const x0 = cx - triW / 2;
            const x1 = cx + triW / 2;
            let body =
                `<path d="M ${x0} ${cy - half} L ${x1} ${cy} L ${x0} ${cy + half} Z" ` +
                `stroke="${theme.stroke}" stroke-width="${sw}" fill="${theme.stroke}"/>` +
                `<line x1="${x1}" y1="${cy - half}" x2="${x1}" y2="${cy + half}" ${stroke}/>`;
            if (kind === 'led') {
                body += `<path d="M ${x0 + 2} ${cy - half - 1} l 3 -3 m -3 0 l 3 0 l 0 3" ` +
                    `${stroke} transform="rotate(-15 ${x0 + 2} ${cy - half - 1})"/>`;
            }
            return { halfW: triW / 2 + sw, body };
        }
    }
}

/**
 * The fully collapsed passive: entry lead, symbol, exit lead carrying the
 * designator above the line and the value below it.
 */
export function passiveFullIcon(kind: string, designator: string, value: string,
                                fontSize: number, theme: SymbolTheme): vscode.Uri {
    const { h, cy, sw, ch } = canvasFor(fontSize);
    const labelSize = Math.round(fontSize * 0.68);
    const labelW = Math.max(designator.length, value.length) * labelSize * 0.62;
    const entry = Math.round(1.2 * ch);
    const symHalf = symbolBody(kind, 0, 0, fontSize, theme, sw).halfW;
    const cx = entry + symHalf;
    const exitW = Math.max(Math.round(2.5 * ch), Math.round(labelW + ch));
    const w = Math.round(cx + symHalf + exitW);
    const { body } = symbolBody(kind, cx, cy, fontSize, theme, sw);
    const lead = (x1: number, x2: number) =>
        `<line x1="${x1}" y1="${cy}" x2="${x2}" y2="${cy}" stroke="${theme.wire}" ` +
        `stroke-width="${sw}"/>`;
    const labelX = cx + symHalf + exitW / 2;
    let svg = lead(0, cx - symHalf) + lead(cx + symHalf, w) + body;
    if (designator) svg += textEl(labelX, cy - Math.round(fontSize * 0.42),
                                 labelSize, theme.label, designator);
    if (value) svg += textEl(labelX, cy + Math.round(fontSize * 0.45),
                             labelSize, theme.label, value);
    return svgUri(w, h, svg);
}

/** A chain net reference re-drawn on the wire: the name above the line, a
 *  ground drop below it, or a rail tick, per kind. */
export function netLabelIcon(name: string, kind: 'plain' | 'ground' | 'rail',
                             fontSize: number, theme: SymbolTheme): vscode.Uri {
    const { h, cy, sw, ch } = canvasFor(fontSize);
    const labelSize = Math.round(fontSize * 0.7);
    const textW = Math.round(name.length * labelSize * 0.62) + 4;
    const lead = (x1: number, x2: number) =>
        `<line x1="${x1}" y1="${cy}" x2="${x2}" y2="${cy}" stroke="${theme.wire}" ` +
        `stroke-width="${sw}"/>`;
    const stroke = `stroke="${theme.stroke}" stroke-width="${sw}" fill="none"`;

    if (kind === 'ground') {
        // The drop sits where the wire lands -- flush with the connecting
        // net -- and the name stands beside it at wire height.
        const gx = 6;
        const w = gx + 8 + textW;
        const y0 = cy + Math.round(fontSize * 0.16);
        let svg = lead(0, gx) +
            `<line x1="${gx}" y1="${cy}" x2="${gx}" y2="${y0}" ${stroke}/>` +
            `<line x1="${gx - 5}" y1="${y0}" x2="${gx + 5}" y2="${y0}" ${stroke}/>` +
            `<line x1="${gx - 3}" y1="${y0 + 3}" x2="${gx + 3}" y2="${y0 + 3}" ${stroke}/>` +
            `<line x1="${gx - 1}" y1="${y0 + 6}" x2="${gx + 1}" y2="${y0 + 6}" ${stroke}/>`;
        svg += textEl(gx + 8 + textW / 2, cy, labelSize, theme.label, name);
        return svgUri(w, h, svg);
    }

    const w = Math.max(textW + 4, Math.round(1.5 * ch));
    let svg = lead(0, w);
    if (kind === 'rail') {
        const ax = 4;
        const top = cy - Math.round(fontSize * 0.85);
        svg += `<line x1="${ax}" y1="${cy}" x2="${ax}" y2="${top + 3}" ${stroke}/>` +
            `<path d="M ${ax - 3} ${top + 4} L ${ax} ${top} L ${ax + 3} ${top + 4} Z" ` +
            `stroke="none" fill="${theme.stroke}"/>`;
        svg += textEl(ax + 4 + (w - ax - 4) / 2, cy - Math.round(fontSize * 0.42),
                      labelSize, theme.label, name);
    } else {
        svg += textEl(w / 2, cy - Math.round(fontSize * 0.42), labelSize, theme.label, name);
    }
    return svgUri(w, h, svg);
}

/** One cell of the yellow instance pin box: the header carries the
 *  designator and part, each pin row its pin name and a wire stub. */
export type CellRole = 'header' | 'pin' | 'filler' | 'closer';
export function pinCellIcon(label: string, widthCh: number, role: CellRole,
                            fontSize: number, theme: SymbolTheme,
                            padCh = 0): vscode.Uri {
    const header = role === 'header';
    const last = role === 'closer';
    const ch = cellWidth(fontSize);
    // Two pixels past the line pitch, so stacked cells touch and the column
    // reads as one body.
    const h = Math.round(fontSize * 1.9) + 2;
    const cy = Math.round(h - fontSize * 0.30) - iconDrop(fontSize) - 2;
    const sw = Math.max(1.2, fontSize / 12);
    const pad = Math.round(padCh * ch);
    const boxW = Math.round(widthCh * ch);
    const stub = role === 'pin' ? Math.round(1.2 * ch) : 0;
    const w = pad + boxW + stub;
    const size = Math.round(fontSize * (header ? 0.72 : 0.78));
    const x0 = pad + sw / 2;
    const x1 = pad + boxW - sw / 2;
    let svg = `<rect x="${x0}" y="0" width="${boxW - sw}" height="${h}" ` +
        `fill="${theme.boxFill}" stroke="none"/>` +
        `<line x1="${x0}" y1="0" x2="${x0}" y2="${h}" ` +
        `stroke="${theme.boxStroke}" stroke-width="${sw}"/>` +
        `<line x1="${x1}" y1="0" x2="${x1}" y2="${h}" ` +
        `stroke="${theme.boxStroke}" stroke-width="${sw}"/>`;
    if (header) {
        svg += `<line x1="${x0}" y1="${sw / 2}" x2="${x1}" y2="${sw / 2}" ` +
            `stroke="${theme.boxStroke}" stroke-width="${sw}"/>`;
    }
    if (last) {
        svg += `<line x1="${x0}" y1="${h - sw / 2}" x2="${x1}" y2="${h - sw / 2}" ` +
            `stroke="${theme.boxStroke}" stroke-width="${sw}"/>`;
    }
    if (label) {
        const esc = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // Pin names sit against the right edge, at the pin they name; the
        // header stays flush left.
        const tx = header ? pad + Math.round(0.6 * ch) : pad + boxW - Math.round(0.6 * ch);
        svg += `<text x="${tx}" y="${cy}" font-family="monospace" ` +
            `font-size="${size}" fill="${header ? theme.boxStroke : theme.stroke}" ` +
            `${header ? '' : 'text-anchor="end" '}dominant-baseline="central">${esc}</text>`;
    }
    if (stub > 0) {
        svg += `<line x1="${pad + boxW}" y1="${cy}" x2="${w}" y2="${cy}" ` +
            `stroke="${theme.wire}" stroke-width="${sw}"/>`;
    }
    return svgUri(w, h, svg);
}

/**
 * Builds the symbol image for one device. Height is one line's worth; the
 * conductor sits at mid-height so the wire strike-through lines meet it.
 */
export function deviceIcon(kind: string, value: string, fontSize: number,
                           theme: SymbolTheme): { uri: vscode.Uri; } {
    const ch = cellWidth(fontSize);
    // Calibrated against a real render at the 1.9 line height this extension
    // sets for manta files: the image is bottom-anchored with the wire
    // strike-through 0.30 em above its bottom, and the whole image is dropped
    // by iconDrop() (vertical-align) so the wire crosses mid-canvas and
    // symbols can centre on it like parts on a schematic.
    const h = Math.round(fontSize * 1.8);
    const cy = Math.round(h - fontSize * 0.30) - iconDrop(fontSize);
    const sw = Math.max(1.2, fontSize / 12);
    const stroke = `stroke="${theme.stroke}" stroke-width="${sw}" fill="none"`;
    const lead = (x1: number, x2: number) =>
        `<line x1="${x1}" y1="${cy}" x2="${x2}" y2="${cy}" stroke="${theme.wire}" ` +
        `stroke-width="${sw}"/>`;
    const valueSize = Math.round(fontSize * 0.8);

    switch (kind) {
        case 'resistor': {
            // IEC box, five cells, value inside.
            const w = 5 * ch;
            const boxX = Math.round(0.4 * ch);
            const boxW = w - 2 * boxX;
            const boxH = Math.round(fontSize * 1.1);
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
            const rise = Math.min(r * 1.6, fontSize * 0.75);
            for (let k = 0; k < humps; k++) d += ` a ${r} ${rise} 0 0 1 ${2 * r} 0`;
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
            const gap = Math.max(4, Math.round(ch * 0.5));
            const p1 = symW / 2 - gap / 2;
            const p2 = symW / 2 + gap / 2;
            const plateUp = Math.round(fontSize * 0.55);
            const plateDown = Math.round(fontSize * 0.55);
            const textW = value ? Math.round(value.length * valueSize * 0.62) + 4 : 0;
            const w = symW + textW;
            const body = lead(0, p1) + lead(p2, symW) +
                `<line x1="${p1}" y1="${cy - plateUp}" x2="${p1}" y2="${cy + plateDown}" ${stroke}/>` +
                `<line x1="${p2}" y1="${cy - plateUp}" x2="${p2}" y2="${cy + plateDown}" ${stroke}/>` +
                (value ? textEl(symW + textW / 2, cy, valueSize, theme.stroke, value) : '');
            return { uri: svgUri(w, h, body) };
        }
        case 'diode':
        case 'led': {
            const symW = 3 * ch;
            const triW = Math.round(1.2 * ch);
            const x0 = symW / 2 - triW / 2;
            const x1 = symW / 2 + triW / 2;
            const half = Math.round(fontSize * 0.42);
            const textW = value ? Math.round(value.length * valueSize * 0.62) + 4 : 0;
            const w = symW + textW;
            let body = lead(0, x0) + lead(x1, symW) +
                `<path d="M ${x0} ${cy - half} L ${x1} ${cy} L ${x0} ${cy + half} Z" ` +
                `stroke="${theme.stroke}" stroke-width="${sw}" fill="${theme.stroke}"/>` +
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
