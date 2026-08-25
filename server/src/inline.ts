// SPDX-FileCopyrightText: 2026 Tom
// SPDX-License-Identifier: GPL-3.0-or-later
// Inline-schematic facts for the editor: which spans are wires, which device
// references can collapse to a symbol, which net names deserve a ground or
// rail glyph. Pure text analysis over the lexer's tokens -- the client turns
// the facts into decorations and knows nothing about manta.
//
// The walker here is deliberately shallower than the compiler's parser: it
// tracks elements and connectors well enough to draw, and silently skips
// anything it does not recognise. A wrong guess costs a missing decoration,
// never a wrong diagnostic.

import { Token, TokenKind, tokenize } from './lexer';

/** One span on one line, in UTF-16 columns as the editor counts them. */
export interface InlineSpan {
    line: number;
    start: number;
    end: number;
}

export interface InlineDevice {
    /** The '~PART-NAME' span the editor may hide. */
    hide: InlineSpan;
    /** What to draw in its place. */
    kind: 'resistor' | 'capacitor' | 'inductor' | 'diode' | 'led';
    /** The value, when one is known: "10kR", "100nF". Empty otherwise. */
    value: string;
}

export interface InlineJoin {
    span: InlineSpan;
    /**
     * False: a plain '=' join, drawn as a faint line under the gap between
     * the two terminals. True: a '==' continuation, drawn over the dead-end
     * element it hops -- up and over the part.
     */
    over: boolean;
}

export interface InlineMark {
    span: InlineSpan;
    kind: 'ground' | 'rail';
}

export interface InlineFacts {
    devices: InlineDevice[];
    joins: InlineJoin[];
    marks: InlineMark[];
    /** Terminal dots -- '.' tokens standing on a wire -- drawn mid-height. */
    dots: InlineSpan[];
}

/** R1 -> resistor, C? -> capacitor ... anything else -> undefined. */
function kindOf(designator: string, partName: string): InlineDevice['kind'] | undefined {
    const m = /^([A-Za-z]+)(\d+|\?)$/.exec(designator);
    if (!m) return undefined;
    switch (m[1]) {
        case 'R': return 'resistor';
        case 'C': return 'capacitor';
        case 'L': return 'inductor';
        case 'D': return /led/i.test(partName) ? 'led' : 'diode';
        default: return undefined;
    }
}

/** "R-10kR-0603" -> "10kR"; "C-100nF-0603" -> "100nF"; "" when nothing reads. */
export function valueFromPartName(partName: string): string | undefined {
    const m = /(?:^|-)(\d+(?:[pnumkMGT]\d*)?(?:\.\d+)?[pnumkMGT]?(?:R|F|H))(?:-|$)/.exec(partName);
    return m ? m[1] : undefined;
}

const RAIL_NAME = /^(?:\d+V\d*|V(?:CC|DD|EE|SS|BAT|BUS|IN|OUT|SYS|POS|NEG|PWR)[\w+-]*)$/;

function spanOf(t: Token): InlineSpan {
    return { line: t.line, start: t.character, end: t.character + t.text.length };
}

export function computeInline(
    text: string,
    lookupValue: (partName: string) => string | undefined,
): InlineFacts {
    const { tokens, contentEnd } = tokenize(text);
    const facts: InlineFacts = { devices: [], joins: [], marks: [], dots: [] };

    // Meaningful tokens only, stopping at the end-of-content marker.
    const ts: Token[] = [];
    for (const t of tokens) {
        if (t.kind === TokenKind.EndOfFile || t.kind === TokenKind.EndOfContent) break;
        if (contentEnd >= 0 && t.start >= contentEnd) break;
        if (t.kind === TokenKind.Comment || t.kind === TokenKind.SectionMarker) continue;
        ts.push(t);
    }

    const isPunct = (i: number, p: string) => ts[i] !== undefined
        && ts[i].kind === TokenKind.Punct && ts[i].text === p;
    const isWord = (i: number) => ts[i] !== undefined && ts[i].kind === TokenKind.Word;

    // ---- pass 1: net names declared ground or rail ------------------------
    const groundNames = new Set<string>();
    const railNames = new Set<string>();
    for (let i = 0; i < ts.length; i++) {
        if (!isPunct(i, '&') || !isWord(i + 1)) continue;
        const name = ts[i + 1].text;
        // The subject is the word that opened the statement: scan back past
        // nothing -- these directives follow their net directly in practice.
        const subject = i >= 1 && isWord(i - 1) ? ts[i - 1].text : undefined;
        if (!subject) continue;
        if (name === 'TYPE' && isPunct(i + 2, '=') && isWord(i + 3) && ts[i + 3].text === 'GROUND') {
            groundNames.add(subject);
        }
        if (name === 'RAIL') railNames.add(subject);
        if (name === 'CLASS' && isPunct(i + 2, '=') && isWord(i + 3)
            && /(^|[-_])power([-_]|$)/.test(ts[i + 3].text)) {
            railNames.add(subject);
        }
    }

    const isGroundName = (name: string) => groundNames.has(name) || /GND$/.test(name);
    const isRailName = (name: string) => railNames.has(name) || RAIL_NAME.test(name);

    // ---- pass 2: devices, joins and marks ---------------------------------
    // An element extent, as token indices [firstTok, lastTok].
    interface Extent { first: number; last: number; }

    const matchClose = (i: number, open: string, close: string): number => {
        let depth = 0;
        for (let j = i; j < ts.length; j++) {
            if (ts[j].kind !== TokenKind.Punct) continue;
            if (ts[j].text === open) depth++;
            else if (ts[j].text === close && --depth === 0) return j;
        }
        return -1;
    };

    // Skips a '&'/'#'/'@' annotation starting at i; returns the index after it.
    const skipAnnotation = (i: number): number => {
        let j = i + 1;
        while (isPunct(j, '~') || isPunct(j, '!')) j++;
        if (isWord(j)) j++;
        if (isPunct(j, '=')) {
            j++;
            // The value: a word, a string, a '?' or a '%[...]'/'[...]' list.
            if (isPunct(j, '%')) j++;
            if (isPunct(j, '[')) {
                const close = matchClose(j, '[', ']');
                j = close >= 0 ? close + 1 : j + 1;
            } else if (ts[j] !== undefined
                       && (ts[j].kind === TokenKind.Word || ts[j].kind === TokenKind.String
                           || (ts[j].kind === TokenKind.Punct && ts[j].text === '?'))) {
                j++;
            }
        }
        return j;
    };

    // Parses one element starting at i. Returns its extent, or null when the
    // token cannot begin one. Recurses into binding lists for their chains.
    const parseElement = (i: number): Extent | null => {
        if (ts[i] === undefined) return null;
        const first = i;
        let j = i;

        // Leading arrows on a net.
        while (isPunct(j, '>') || isPunct(j, '<') || isPunct(j, '<>') || isPunct(j, '>>')) j++;

        // Entry terminal: a dot run, or name/list attached through a dot.
        if (isPunct(j, '.')) {
            while (isPunct(j, '.')) facts.dots.push(spanOf(ts[j++]));
            if (!isPunct(j, '{')) {
                // Not a device: a binding's '.PIN' (pin of this instance) or
                // its bare '.' casual pin -- an element in its own right.
                if (isWord(j)) {
                    j++;
                    if (isPunct(j, '[')) {
                        const close = matchClose(j, '[', ']');
                        if (close >= 0) j = close + 1;
                    }
                }
                return { first, last: j - 1 };
            }
        } else if (isPunct(j, '[') && ts[matchClose(j, '[', ']') + 1] !== undefined
                   && isPunct(matchClose(j, '[', ']') + 1, '.')) {
            j = matchClose(j, '[', ']') + 2;
            facts.dots.push(spanOf(ts[j - 1]));
            if (!isPunct(j, '{')) return null;
        } else if (isWord(j) && isPunct(j + 1, '.') && isPunct(j + 2, '{')) {
            facts.dots.push(spanOf(ts[j + 1]));
            j += 2;
        }

        if (isPunct(j, '{')) {
            const close = matchClose(j, '{', '}');
            if (close < 0) return null;
            handleDevice(j, close);
            walkBindings(j + 1, close);
            j = close + 1;
            // Exit terminal: '.', '.NAME', '.[list]', or a dot run.
            if (isPunct(j, '.')) {
                facts.dots.push(spanOf(ts[j]));
                j++;
                if (isWord(j)) {
                    j++;
                    if (isPunct(j, '[')) j = matchClose(j - 0, '[', ']') + 1;
                } else if (isPunct(j, '[')) {
                    j = matchClose(j, '[', ']') + 1;
                } else {
                    while (isPunct(j, '.')) facts.dots.push(spanOf(ts[j++]));
                }
            }
            return { first, last: j - 1 };
        }

        if (isPunct(j, '(')) {
            const close = matchClose(j, '(', ')');
            if (close < 0) return null;
            walkChain(j + 1, close);
            j = close + 1;
            // Multiplicity: ')*4' and friends.
            if ((isPunct(j, '*') || isPunct(j, '+') || isPunct(j, '|')) && isWord(j + 1)) j += 2;
            return { first, last: j - 1 };
        }
        if (isPunct(j, '[') && isPunct(j + 1, '[')) {
            const close = matchClose(j, '[', ']');
            if (close < 0) return null;
            walkChain(j + 2, close - 1);
            return { first, last: close };
        }

        if (isWord(j)) {
            markNet(ts[j]);
            j++;
            // A dotted path ('U1.GPIO1', 'i2c.SDA') or an index.
            while (isPunct(j, '.') && isWord(j + 1)) {
                markNet(ts[j + 1]);
                j += 2;
            }
            if (isPunct(j, '[')) {
                const close = matchClose(j, '[', ']');
                if (close >= 0) j = close + 1;
            }
            // Trailing arrows.
            while (isPunct(j, '>') || isPunct(j, '<') || isPunct(j, '<>') || isPunct(j, '>>')) j++;
            return { first, last: j - 1 };
        }
        return null;
    };

    const markNet = (t: Token) => {
        if (isGroundName(t.text)) facts.marks.push({ span: spanOf(t), kind: 'ground' });
        else if (isRailName(t.text)) facts.marks.push({ span: spanOf(t), kind: 'rail' });
    };

    // The '{DES~PART' inside a device: record the collapsible '~PART' span.
    const handleDevice = (open: number, close: number) => {
        let j = open + 1;
        if (isPunct(j, '!')) j++;
        if (!isWord(j)) return;
        let designator = ts[j].text;
        j++;
        if (isPunct(j, '?')) {
            designator += '?';
            j++;
        }
        if (!isPunct(j, '~') || !isWord(j + 1) || j + 1 >= close) return;
        const partName = ts[j + 1].text;
        const kind = kindOf(designator, partName);
        if (!kind) return;
        if (ts[j].line !== ts[j + 1].line) return;
        const value = lookupValue(partName) ?? valueFromPartName(partName) ?? '';
        facts.devices.push({
            hide: { line: ts[j].line, start: ts[j].character,
                    end: ts[j + 1].character + ts[j + 1].text.length },
            kind,
            value,
        });
    };

    const KEYWORDS = new Set(['block', 'part', 'harness', 'netclass', 'match',
                              'cable', 'static', 'rules', 'check']);

    // One chain (or binding right-hand side) between token indices [i, end).
    const walkChain = (i: number, end: number) => {
        let j = i;
        let prev: Extent | null = null;
        while (j < end && ts[j] !== undefined) {
            if (isPunct(j, ';') || isPunct(j, '^')) {
                prev = null;
                j++;
                continue;
            }
            // A declaration: skip its header, walk its body as statements.
            if (isWord(j) && KEYWORDS.has(ts[j].text)) {
                while (j < end && !isPunct(j, '{') && !isPunct(j, ';')) j++;
                if (isPunct(j, '{')) {
                    const close = matchClose(j, '{', '}');
                    if (close < 0) return;
                    walkChain(j + 1, close);
                    j = close + 1;
                } else {
                    j++;
                }
                prev = null;
                continue;
            }
            if (isPunct(j, '&') || isPunct(j, '#') || isPunct(j, '@')) {
                j = skipAnnotation(j);
                continue;
            }
            if (isPunct(j, '=') || isPunct(j, '==') || isPunct(j, '=*') || isPunct(j, '*=')) {
                const conn = ts[j];
                const next = parseElement(j + 1);
                if (prev !== null && next !== null) {
                    const over = conn.text === '==';
                    const from = over ? ts[prev.first] : ts[prev.last];
                    const to = ts[next.first];
                    const fromChar = over ? from.character
                                          : from.character + from.text.length;
                    if (from.line === to.line && fromChar < to.character) {
                        facts.joins.push({
                            span: { line: from.line, start: fromChar, end: to.character },
                            over,
                        });
                    }
                    prev = next;
                    j = next.last + 1;
                } else {
                    prev = null;
                    j++;
                }
                continue;
            }
            const el = parseElement(j);
            if (el !== null) {
                prev = el;
                j = el.last + 1;
            } else {
                j++;
            }
        }
    };

    // A binding list: '{DES~PART: bindings }'. Each binding after the ':' is
    // '.PIN <connector> <segment>' -- a chain rooted at the pin.
    const walkBindings = (i: number, end: number) => {
        let j = i;
        // Skip to the ':' that opens the list, staying at this brace depth.
        let depth = 0;
        for (; j < end; j++) {
            if (isPunct(j, '{')) depth++;
            else if (isPunct(j, '}')) depth--;
            else if (depth === 0 && isPunct(j, ':')) break;
        }
        if (j >= end) return;
        walkChain(j + 1, end);
    };

    // Top level: split into statements at ';' and walk each. Declarations
    // (part/block/...) recurse naturally: their braces are walked for chains,
    // and part bodies contain no connectors that survive the annotation skip.
    walkChain(0, ts.length);

    return facts;
}
