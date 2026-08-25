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
    /** The span the editor may hide: '~PART-NAME', or in the full form the
     *  whole element ('.{R5~R-100kR-0603}.'). */
    hide: InlineSpan;
    /** What to draw in its place. */
    kind: 'resistor' | 'capacitor' | 'inductor' | 'diode' | 'led';
    /** The value, when one is known: "10kR", "100nF". Empty otherwise. */
    value: string;
    /** The designator: "R5". */
    designator: string;
    /** Set for a pure passthrough passive with no binding list: the whole
     *  element ('.{R5~part}.'), which full-sugar mode may collapse into one
     *  drawing carrying its own terminals, designator and value. */
    fullSpan?: InlineSpan;
    /** Set for a shunt passive with exactly one binding: the head
     *  ('.{C10~part:'), drawn like a full passive whose exit lead runs on
     *  into the binding's chain. */
    headSpan?: InlineSpan;
    /** A diode drawn cathode-first: the entry terminal was 'K' (or the
     *  exit terminal was 'A'). */
    mirror?: boolean;
    /** Set on a collapsed head hopped by '==': the drawing carries the
     *  riser and top line of the up-and-over bypass. */
    hop?: boolean;
}

export interface InlineJoin {
    span: InlineSpan;
    /**
     * False: a plain '=' join, drawn as a faint line under the gap between
     * the two terminals. True: a '==' continuation, drawn over the dead-end
     * element it hops -- up and over the part.
     */
    over: boolean;
    /** Full-sugar hop rendering: 'span' covers the hopped element (wire
     *  plus top line), 'mid' is a join inside it (same), 'tail' the plain
     *  wire from the element to what follows. */
    hop?: 'span' | 'mid' | 'tail';
}

export interface InlineMark {
    span: InlineSpan;
    kind: 'ground' | 'rail';
}

export interface InlineFacts {
    devices: InlineDevice[];
    joins: InlineJoin[];
    marks: InlineMark[];
    /** Terminal dots -- '.' tokens standing on a wire -- drawn mid-height.
     *  `over` marks dots inside a hopped element: the top line runs over. */
    dots: (InlineSpan & { over?: boolean })[];
    /** '='/'==' connector tokens, hidden entirely in full-sugar mode. */
    equals: InlineSpan[];
    /** Chain net references, redrawn as names standing on the wire. `pos`
     *  says which way the wire runs past them; `boxWidth` is set when the
     *  net hangs off a pin box, for the document-wide label column. */
    nets: { span: InlineSpan; kind: 'plain' | 'ground' | 'rail';
            pos: 'start' | 'mid' | 'end'; boxWidth?: number;
            hop?: 'mid' | 'end' }[];
    /** Unrecognised parts used inline -- testpoints, crystals -- drawn as a
     *  small yellow part box. */
    parts: { span: InlineSpan; label: string; entry: boolean; exit: boolean }[];
    /** Spans full sugar hides outright: shunt tails, binding-row gaps. */
    hides: InlineSpan[];
    /** The widest pin box in the document, for the label column. */
    boxCol: number;
    /** '{DES~PART:' opens of instances drawn as a pin box. `entry` names
     *  the entry-connected pin when the chain reaches the box from a net. */
    headers: { span: InlineSpan; width: number; label: string;
               entry?: string }[];
    /** '.PIN' openers of bindings, drawn as the box's pin cells. `pad`
     *  shifts a cell right when its row sits left of the box column. */
    pins: { span: InlineSpan; width: number; last: boolean; pad?: number }[];
    /** Box lines with no pin -- comments, blanks, continuations -- so the
     *  column runs unbroken. `col` is the header's column. */
    fillers: { line: number; col: number; width: number }[];
    /** The '};' closing a boxed instance: hidden under the bottom cell.
     *  `pad` shifts it right when the text sits left of the box column. */
    closers: { span: InlineSpan; width: number; pad?: number }[];
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
    const facts: InlineFacts = { devices: [], joins: [], marks: [], dots: [],
                                 equals: [], nets: [], headers: [], pins: [],
                                 fillers: [], closers: [], parts: [], hides: [],
                                 boxCol: 0 };

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

        let entryDots = 0;

        // Entry terminal: a dot run, or name/list attached through a dot.
        if (isPunct(j, '.')) {
            while (isPunct(j, '.')) { facts.dots.push(spanOf(ts[j++])); entryDots++; }
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
            const bindings = hasBindingList(j, close);
            const dev = handleDevice(j, close);
            // The name of a named entry terminal ('K.{D2'), for orientation.
            const entryName = first < j && isWord(j - 2) && isPunct(j - 1, '.')
                ? ts[j - 2].text : '';
            if (bindings) {
                recordBox(j, close, dev, first, entryName);
                walkBindings(j + 1, close);
            }
            j = close + 1;
            // Exit terminal: '.', '.NAME', '.[list]', or a dot run.
            let exitDots = 0;
            let exitNamed = false;
            let exitName = '';
            if (isPunct(j, '.')) {
                facts.dots.push(spanOf(ts[j]));
                exitDots++;
                j++;
                if (isWord(j)) {
                    exitNamed = true;
                    exitName = ts[j].text;
                    j++;
                    if (isPunct(j, '[')) j = matchClose(j - 0, '[', ']') + 1;
                } else if (isPunct(j, '[')) {
                    exitNamed = true;
                    j = matchClose(j, '[', ']') + 1;
                } else {
                    while (isPunct(j, '.')) { facts.dots.push(spanOf(ts[j++])); exitDots++; }
                }
            }
            const oneLine = ts[first].line === ts[j - 1].line;
            const elementSpan = (): InlineSpan => ({
                line: ts[first].line,
                start: ts[first].character,
                end: ts[j - 1].character + ts[j - 1].text.length,
            });

            // A passthrough passive with no binding list collapses whole:
            // the drawing carries its own terminals, designator and value.
            // Named terminals qualify too -- a diode entered at K draws
            // cathode-first.
            if (dev >= 0 && !bindings && oneLine
                && (entryDots === 1 || entryName !== '')) {
                facts.devices[dev].fullSpan = elementSpan();
                if (entryName.toUpperCase() === 'K'
                    || exitName.toUpperCase() === 'A') facts.devices[dev].mirror = true;
            }

            // A shunt passive with exactly one binding collapses its head --
            // '.{C10~part:' -- and hides its tail, so the drawing's exit lead
            // runs on into the binding's chain (the cap to its ground).
            if (dev >= 0 && bindings && oneLine && facts.devices[dev] !== undefined) {
                const colon = colonOf(ts, close, (k, p) => isPunct(k, p));
                const bindingCount = countBindings(colon, close);
                if (colon >= 0 && bindingCount === 1 && ts[colon].line === ts[first].line) {
                    facts.devices[dev].headSpan = {
                        line: ts[first].line,
                        start: ts[first].character,
                        end: ts[colon].character + 1,
                    };
                    if (entryName.toUpperCase() === 'K') facts.devices[dev].mirror = true;
                    // Hide the tail: an inner ';' hugging the '}' and the
                    // '}' itself.
                    let tailStart = close;
                    if (isPunct(close - 1, ';') && ts[close - 1].line === ts[close].line) {
                        tailStart = close - 1;
                    }
                    facts.hides.push({
                        line: ts[close].line, start: ts[tailStart].character,
                        end: ts[close].character + 1,
                    });
                    // Hide the binding's opener ('.' or '.A'): the drawing's
                    // exit lead stands for that pin, and the chain after it
                    // runs on into the sugar.
                    let b = colon + 1;
                    if (isPunct(b, '.')) {
                        let e = b;
                        if (isWord(b + 1) && ts[b + 1].line === ts[b].line) e = b + 1;
                        // From just after the ':' so the gap before the
                        // opener vanishes too -- the wire stays unbroken.
                        facts.hides.push({ line: ts[b].line,
                                           start: ts[colon].character + 1,
                                           end: ts[e].character + ts[e].text.length });
                    }
                }
            }

            // A single-line instance with a binding list -- a connector, an
            // addressed LED -- draws as a yellow chip for the part plus one
            // chip per named pin, each wired on to its net. (A passive with
            // exactly one binding collapsed above instead.)
            if (bindings && oneLine) {
                const colon2 = colonOf(ts, close, (k, p) => isPunct(k, p));
                const nBind = countBindings(colon2, close);
                if (colon2 >= 0 && !(dev >= 0 && nBind === 1)) {
                    const label = partLabel(j0Open(ts, first, i), close);
                    if (label) {
                        facts.parts.push({
                            span: { line: ts[first].line, start: ts[first].character,
                                    end: ts[colon2].character + 1 },
                            label,
                            entry: entryDots > 0 || entryName !== '',
                            exit: false,
                        });
                        let depth2 = 0;
                        let atStart2 = true;
                        for (let k = colon2 + 1; k < close; k++) {
                            if (isPunct(k, '{')) { depth2++; atStart2 = false; continue; }
                            if (isPunct(k, '}')) { depth2--; atStart2 = false; continue; }
                            if (depth2 > 0) continue;
                            if (isPunct(k, ';')) { atStart2 = true; continue; }
                            if (atStart2 && isPunct(k, '.') && isWord(k + 1)
                                && ts[k + 1].line === ts[k].line) {
                                let e = k + 1;
                                let name = ts[e].text;
                                if (isPunct(e + 1, '[')) {
                                    const rb = matchClose(e + 1, '[', ']');
                                    if (rb >= 0 && ts[rb].line === ts[k].line) {
                                        name += ts.slice(e + 1, rb + 1)
                                            .map((t) => t.text).join('');
                                        e = rb;
                                    }
                                }
                                facts.parts.push({
                                    span: { line: ts[k].line, start: ts[k].character,
                                            end: ts[e].character + ts[e].text.length },
                                    label: name, entry: false, exit: true,
                                });
                            }
                            atStart2 = false;
                        }
                        if (dev >= 0 && facts.devices[dev] !== undefined
                            && facts.devices[dev].headSpan === undefined
                            && facts.devices[dev].fullSpan === undefined) {
                            facts.devices.splice(dev, 1);
                        }
                    }
                }
            }

            // An unrecognised part used inline -- a testpoint, a crystal --
            // draws as a small yellow part box with its designator and part.
            if (dev < 0 && !bindings && oneLine) {
                const label = partLabel(j0Open(ts, first, i), close);
                if (label) {
                    facts.parts.push({
                        span: elementSpan(),
                        label,
                        entry: entryDots > 0 || entryName !== '',
                        exit: exitDots > 0 || exitNamed,
                    });
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
            const nameFirst = j;
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
            if (ts[nameFirst].line === ts[j - 1].line) {
                const name = ts[nameFirst].text;
                facts.nets.push({
                    span: { line: ts[nameFirst].line, start: ts[nameFirst].character,
                            end: ts[j - 1].character + ts[j - 1].text.length },
                    kind: isGroundName(name) ? 'ground' : isRailName(name) ? 'rail' : 'plain',
                    pos: 'end',
                });
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

    // The '{DES~PART' inside a device. Returns the pushed device index, or
    // -1 when the instance is not a drawable passive.
    const handleDevice = (open: number, close: number): number => {
        let j = open + 1;
        if (isPunct(j, '!')) j++;
        if (!isWord(j)) return -1;
        let designator = ts[j].text;
        j++;
        if (isPunct(j, '?')) {
            designator += '?';
            j++;
        }
        if (!isPunct(j, '~') || !isWord(j + 1) || j + 1 >= close) return -1;
        const partName = ts[j + 1].text;
        const kind = kindOf(designator, partName);
        if (!kind) return -1;
        if (ts[j].line !== ts[j + 1].line) return -1;
        const value = lookupValue(partName) ?? valueFromPartName(partName) ?? '';
        facts.devices.push({
            hide: { line: ts[j].line, start: ts[j].character,
                    end: ts[j + 1].character + ts[j + 1].text.length },
            kind,
            value,
            designator,
        });
        return facts.devices.length - 1;
    };

    // A non-passive instance with a binding list draws as a pin box: a
    // header cell for '{DES~PART:' and one yellow cell per '.PIN' opener,
    // all of one width so the column reads as a single body.
    const recordBox = (open: number, close: number, dev: number,
                       first: number, entryName: string) => {
        // The ':' that opens the binding list, at this brace's own depth.
        let colon = -1;
        let depth = 0;
        for (let k = open + 1; k < close; k++) {
            if (isPunct(k, '{')) depth++;
            else if (isPunct(k, '}')) depth--;
            else if (depth === 0 && isPunct(k, ':')) { colon = k; break; }
        }
        if (colon < 0 || ts[open].line !== ts[colon].line) return;

        // Pin openers: a '.' directly after the ':' or a top-level ';'.
        interface Cell { first: number; last: number; name: string; }
        const cells: Cell[] = [];
        depth = 0;
        let atStart = true;
        for (let k = colon + 1; k < close; k++) {
            if (isPunct(k, '{')) { depth++; atStart = false; continue; }
            if (isPunct(k, '}')) { depth--; atStart = false; continue; }
            if (depth > 0) continue;
            if (isPunct(k, ';')) { atStart = true; continue; }
            if (atStart && isPunct(k, '.')) {
                let e = k;
                let name = '';
                if (isWord(k + 1)) {
                    e = k + 1;
                    name = ts[e].text;
                    if (isPunct(e + 1, '[')) {
                        const rb = matchClose(e + 1, '[', ']');
                        if (rb >= 0 && ts[rb].line === ts[k].line) {
                            name += ts.slice(e + 1, rb + 1).map((t) => t.text).join('');
                            e = rb;
                        }
                    }
                }
                if (ts[k].line === ts[e].line) cells.push({ first: k, last: e, name });
            }
            atStart = false;
        }
        // A recognised passive stays a drawn symbol unless it earns a box
        // outright: two or more named pins is a part, whatever its letter --
        // an RGB LED is a yellow part, a catch diode with one bound pin is a
        // diode. Claiming the box un-claims the symbol.
        const named = cells.filter((c) => c.name.length > 0).length;
        if (dev >= 0 && named < 2) return;
        if (cells.length === 0) return;

        // The box only works as a column: every pin opens its own line (a
        // one-line list draws as chips instead). Cells left of the box
        // column pad right to it; deeper ones swallow their indent back.
        const firstOnLine = (k: number) =>
            k === 0 || ts[k - 1].line !== ts[k].line;
        if (cells.every((c) => ts[c.first].line === ts[open].line)) return;
        if (!cells.every((c) => firstOnLine(c.first))) return;
        if (dev >= 0) facts.devices.splice(dev, 1);

        const col = ts[first].character;
        const hasEntry = first < open;
        const label = partLabel(open, close);
        const headerLen = ts[colon].character + 1 - ts[open].character;
        const width = Math.max(headerLen - 2,
                               hasEntry ? label.length + entryName.length + 3 : 0,
                               ...cells.map((c) => c.name.length + 2));
        facts.headers.push({
            span: { line: ts[open].line, start: col,
                    end: ts[colon].character + 1 },
            width,
            label,
            ...(hasEntry ? { entry: entryName } : {}),
        });
        for (const c of cells) {
            const rowCol = ts[c.first].character;
            facts.pins.push({
                span: { line: ts[c.first].line, start: Math.min(col, rowCol),
                        end: ts[c.last].character + ts[c.last].text.length },
                width,
                last: false,
                ...(rowCol < col ? { pad: col - rowCol } : {}),
            });
        }

        // The column runs unbroken over comment, blank and continuation
        // lines, and the bottom cell covers the closing '};'.
        const cellLines = new Set(cells.map((c) => ts[c.first].line));
        const closeLine = ts[close].line;
        for (let line = ts[open].line + 1; line < closeLine; line++) {
            if (!cellLines.has(line)) facts.fillers.push({ line, col, width });
        }
        if (firstOnLine(close)) {
            let end = ts[close].character + 1;
            if (isPunct(close + 1, ';') && ts[close + 1].line === closeLine) {
                end = ts[close + 1].character + 1;
            }
            const closeCol = ts[close].character;
            facts.closers.push({
                span: { line: closeLine, start: Math.min(col, closeCol), end },
                width,
                ...(closeCol < col ? { pad: col - closeCol } : {}),
            });
        }
    };

    // The ':' opening a binding list, at the brace's own depth; -1 if none.
    const colonOf = (_ts: Token[], close: number,
                     isP: (k: number, p: string) => boolean): number => {
        let depth = 0;
        for (let k = openOf(close) + 1; k < close; k++) {
            if (isP(k, '{')) depth++;
            else if (isP(k, '}')) depth--;
            else if (depth === 0 && isP(k, ':')) return k;
        }
        return -1;
    };
    // The '{' matching a ')'-style close index: scan back.
    const openOf = (close: number): number => {
        let depth = 0;
        for (let k = close; k >= 0; k--) {
            if (isPunct(k, '}')) depth++;
            else if (isPunct(k, '{') && --depth === 0) return k;
        }
        return 0;
    };
    // Top-level ';'-separated bindings after the colon.
    const countBindings = (colon: number, close: number): number => {
        if (colon < 0) return 0;
        let depth = 0;
        let count = 0;
        let sawContent = false;
        for (let k = colon + 1; k < close; k++) {
            if (isPunct(k, '{')) depth++;
            else if (isPunct(k, '}')) depth--;
            else if (depth === 0 && isPunct(k, ';')) { if (sawContent) count++; sawContent = false; }
            else if (depth === 0) sawContent = true;
        }
        if (sawContent) count++;
        return count;
    };
    // "DES PART" for the instance whose '{' follows element start.
    const j0Open = (_ts: Token[], _first: number, i: number): number => {
        for (let k = i; k < ts.length; k++) if (isPunct(k, '{')) return k;
        return i;
    };
    const partLabel = (open: number, close: number): string => {
        let k = open + 1;
        if (isPunct(k, '!')) k++;
        if (!isWord(k)) return '';
        let label = ts[k].text;
        k++;
        if (isPunct(k, '?')) { label += '?'; k++; }
        if (isPunct(k, '~') && isWord(k + 1) && k + 1 < close) {
            label += ' ' + ts[k + 1].text;
        }
        return label;
    };

    // Whether an instance carries a binding list: a ':' at its own depth.
    const hasBindingList = (open: number, close: number): boolean => {
        let depth = 0;
        for (let j = open + 1; j < close; j++) {
            if (isPunct(j, '{')) depth++;
            else if (isPunct(j, '}')) depth--;
            else if (depth === 0 && isPunct(j, ':')) return true;
        }
        return false;
    };

    const KEYWORDS = new Set(['block', 'part', 'harness', 'netclass', 'match',
                              'cable', 'static', 'rules', 'check']);

    // One chain (or binding right-hand side) between token indices [i, end).
    const walkChain = (i: number, end: number) => {
        let j = i;
        let prev: Extent | null = null;
        // What the previous element pushed, so a following '==' can mark it
        // hopped: the drawing then carries the up-and-over bypass.
        interface Marks { d0: number; d1: number; n0: number; n1: number;
                          t0: number; t1: number; j0: number; j1: number; }
        let prevMarks: Marks | null = null;
        const snap = (): Marks => ({
            d0: facts.devices.length, d1: 0, n0: facts.nets.length, n1: 0,
            t0: facts.dots.length, t1: 0, j0: facts.joins.length, j1: 0 });
        const seal = (m: Marks): Marks => {
            m.d1 = facts.devices.length; m.n1 = facts.nets.length;
            m.t1 = facts.dots.length; m.j1 = facts.joins.length;
            return m;
        };
        const markHop = (m: Marks) => {
            for (let k = m.d0; k < m.d1; k++) {
                const d = facts.devices[k];
                if (d !== undefined && d.headSpan !== undefined) d.hop = true;
            }
            for (let k = m.n0; k < m.n1; k++) {
                facts.nets[k].hop = k === m.n1 - 1 ? 'end' : 'mid';
            }
            for (let k = m.t0; k < m.t1; k++) facts.dots[k].over = true;
            for (let k = m.j0; k < m.j1; k++) {
                const jn = facts.joins[k];
                if (!jn.over && jn.hop === undefined) jn.hop = 'mid';
            }
        };
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
                if (conn.text === '=' || conn.text === '==') facts.equals.push(spanOf(conn));
                const nextMarks = snap();
                const next = parseElement(j + 1);
                // Seal before any chain-level joins go in: the element's
                // range must hold only what the element itself drew.
                if (next !== null) seal(nextMarks);
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
                    // A '==' hop: mark the dead-end element it bypasses, lay
                    // wire-plus-top-line over it and plain wire on to the
                    // next element, for the full-sugar drawing.
                    if (over && prevMarks !== null) {
                        markHop(prevMarks);
                        const pl = ts[prev.first].line;
                        const prevEnd = ts[prev.last].character
                            + ts[prev.last].text.length;
                        if (ts[prev.last].line === pl) {
                            facts.joins.push({
                                span: { line: pl, start: ts[prev.first].character,
                                        end: prevEnd },
                                over: false, hop: 'span',
                            });
                        }
                        if (ts[prev.last].line === to.line && prevEnd < to.character) {
                            facts.joins.push({
                                span: { line: to.line, start: prevEnd,
                                        end: to.character },
                                over: false, hop: 'tail',
                            });
                        }
                    }
                    prev = next;
                    prevMarks = nextMarks;
                    j = next.last + 1;
                } else {
                    prev = null;
                    prevMarks = null;
                    j++;
                }
                continue;
            }
            const netsBefore = facts.nets.length;
            const elMarks = snap();
            const el = parseElement(j);
            if (el !== null) {
                // A net element just parsed learns which way its wire runs:
                // arrived-from-left, continues-right, or both.
                if (facts.nets.length > netsBefore) {
                    const n = facts.nets[facts.nets.length - 1];
                    const continues =
                        ['=', '==', '=*', '*='].some((p) => isPunct(el.last + 1, p));
                    const arrived = prev !== null;
                    n.pos = arrived && continues ? 'mid' : continues ? 'start' : 'end';
                }
                prev = el;
                prevMarks = seal(elMarks);
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

    // Binding rows join the document-wide label column: the widest pin box
    // sets the column, the gap from the pin cell to its net hides, and the
    // net remembers its box's width so the client can pad the difference.
    const alignColumns = () => {
        facts.boxCol = Math.max(0, ...facts.headers.map((hd) => hd.width));
        // A row aligns only when nothing but its connector stands between
        // the cell and the net -- a row carrying a chain (a diode to ground,
        // a cap on the way) keeps its own drawn layout.
        const chainFree = (line: number, a: number, b: number): boolean => {
            for (let k = 0; k < ts.length; k++) {
                const t = ts[k];
                if (t.line !== line || t.character < a || t.character >= b) continue;
                if (!isPunct(k, '=') && !isPunct(k, '==')) return false;
            }
            return true;
        };
        for (const p of facts.pins) {
            let best: (typeof facts.nets)[number] | undefined;
            for (const n of facts.nets) {
                if (n.span.line !== p.span.line || n.span.start < p.span.end) continue;
                if (!best || n.span.start < best.span.start) best = n;
            }
            if (!best) continue;
            if (!chainFree(p.span.line, p.span.end, best.span.start)) continue;
            best.boxWidth = p.width;
            if (best.span.start > p.span.end) {
                facts.hides.push({ line: p.span.line, start: p.span.end,
                                   end: best.span.start });
            }
        }
    };

    // Top level: split into statements at ';' and walk each. Declarations
    // (part/block/...) recurse naturally: their braces are walked for chains,
    // and part bodies contain no connectors that survive the annotation skip.
    walkChain(0, ts.length);
    alignColumns();

    return facts;
}
