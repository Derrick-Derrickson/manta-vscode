// SPDX-FileCopyrightText: 2026 Tom
// SPDX-License-Identifier: GPL-3.0-or-later
// Extracting a file's declarations from its tokens.
//
// This is an index, not a compiler. It answers "what is declared here, where,
// and what does it say about itself" -- which is what a parts browser and a
// hover need. It does not evaluate chains, resolve names across files, or
// elaborate anything; the compiler does that, and does it properly.
//
// No VS Code or LSP imports, so it can be tested on its own and moved.

import { Token, TokenKind, tokenize } from './lexer';

export type DeclKind = 'part' | 'block' | 'harness' | 'netclass' | 'match' | 'cable';

export interface Range {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
}

export interface Field {
    /** '@' or '#'. */
    namespace: '@' | '#';
    /** '~' weak, '' normal, '!' locked. */
    strength: '~' | '' | '!';
    name: string;
    value: string;
    /** '>' before the sigil, or after the name for an export. */
    direction: 'local' | 'import' | 'export';
    range: Range;
}

export interface Pin {
    /** The physical pin or range, as written: "1" or "[3:11]". */
    physical: string;
    /** The logical name, as written: "VCC", "GPIO[1:9]", "USB.[+,-]". */
    logical: string;
    /** '<', '>', '<>' or ''. */
    arrow: string;
    /** Directives on the line, as written: ["&TYPE=POWER", "&~NET=3V3"]. */
    directives: string[];
    /** '#' fields on the line, as written: ["#VOH=2V4"]. */
    fields: string[];
    /** How many pins this line declares, when it can be counted. */
    count: number;
    range: Range;
}

export interface Section {
    /** The title, as written: everything after the '---' to the end of line. */
    title: string;
    /** The marker line, '---' through the end of the title. */
    range: Range;
}

export interface Declaration {
    kind: DeclKind;
    name: string;
    isStatic: boolean;
    /** The whole declaration. */
    range: Range;
    /** Just the name, for go-to-definition and reveal. */
    selectionRange: Range;
    fields: Field[];
    pins: Pin[];
    /** A leading '//' comment block, which is where a description usually is. */
    doc: string;
    /** Nested declarations, since a block body may contain items. */
    children: Declaration[];
    /** Render section markers (spec 4.7), which only a block body may carry. */
    sections: Section[];
}

export interface ScanResult {
    declarations: Declaration[];
    /** Every '~name' reference, for counting instantiations. */
    instantiations: { name: string; range: Range }[];
}

const KINDS: DeclKind[] = ['part', 'block', 'harness', 'netclass', 'match', 'cable'];

class Scanner {
    private pos = 0;

    constructor(private readonly tokens: Token[], private readonly text: string) {}

    private get cur(): Token {
        return this.tokens[Math.min(this.pos, this.tokens.length - 1)];
    }

    private peek(n = 1): Token {
        return this.tokens[Math.min(this.pos + n, this.tokens.length - 1)];
    }

    private atEnd(): boolean {
        return this.cur.kind === TokenKind.EndOfFile || this.cur.kind === TokenKind.EndOfContent;
    }

    private advance(): Token {
        return this.tokens[this.pos++];
    }

    private is(text: string): boolean {
        return this.cur.text === text && this.cur.kind !== TokenKind.Comment;
    }

    /**
     * A method rather than an inline `this.cur.kind === ...` test on purpose.
     * TypeScript narrows a getter's result and keeps the narrowing across
     * `advance()`, which moves the position out from under it -- so the inline
     * form gets miscompiled into "this comparison has no overlap".
     */
    private atComment(): boolean {
        return this.cur.kind === TokenKind.Comment;
    }

    /** A method for the same narrowing reason as atComment. */
    private atSectionMarker(): boolean {
        return this.cur.kind === TokenKind.SectionMarker;
    }

    private rangeOf(from: Token, to: Token): Range {
        return {
            startLine: from.line,
            startCharacter: from.character,
            endLine: to.line,
            endCharacter: to.character + to.text.length,
        };
    }

    /** Skips comments, collecting them so a leading block can become the doc. */
    private skipComments(): string[] {
        const collected: string[] = [];
        while (this.atComment()) {
            collected.push(this.advance().text);
        }
        return collected;
    }

    /**
     * Every `~name` seen anywhere in the file, at any depth.
     *
     * Filled as the scan walks, because a declaration body is consumed by
     * scanBody and never revisited -- and almost every instantiation in a real
     * design is inside a block body.
     */
    private readonly instantiations: { name: string; range: Range }[] = [];

    /**
     * `designator ~ name`, the form that instantiates a part.
     *
     * The designator is what distinguishes it from the other uses of `~`: a
     * strength modifier follows its sigil, as in `&~LAYER` or `#~mpn`, and
     * reading one of those as an instantiation would invent a part named after
     * a directive.
     */
    private tryInstantiation(): boolean {
        if (!this.is('~') || this.peek().kind !== TokenKind.Word) return false;

        const before = this.tokens[this.pos - 1];
        const isDesignator =
            before !== undefined &&
            (before.kind === TokenKind.Word || before.text === '?' || before.text === ']');
        if (!isDesignator) return false;

        const tilde = this.advance();
        const name = this.advance();
        this.instantiations.push({ name: name.text, range: this.rangeOf(tilde, name) });
        return true;
    }

    scan(): ScanResult {
        const declarations: Declaration[] = [];
        const instantiations = this.instantiations;
        let pendingDoc: string[] = [];

        while (!this.atEnd()) {
            const comments = this.skipComments();
            if (comments.length) {
                pendingDoc = comments;
                continue;
            }
            if (this.atEnd()) break;

            const decl = this.tryDeclaration(pendingDoc);
            if (decl) {
                declarations.push(decl);
                pendingDoc = [];
                continue;
            }

            // Not a declaration. Note any instantiation and move on.
            if (this.tryInstantiation()) continue;

            this.advance();
            pendingDoc = [];
        }

        return { declarations, instantiations };
    }

    private tryDeclaration(doc: string[]): Declaration | null {
        const start = this.pos;
        const first = this.cur;

        let isStatic = false;
        if (this.is('static')) {
            isStatic = true;
            this.advance();
            this.skipComments();
        }

        const kindToken = this.cur;
        if (kindToken.kind !== TokenKind.Word || !KINDS.includes(kindToken.text as DeclKind)) {
            this.pos = start;
            return null;
        }
        this.advance();
        this.skipComments();

        const nameToken = this.cur;
        if (nameToken.kind !== TokenKind.Word) {
            this.pos = start;
            return null;
        }
        this.advance();
        this.skipComments();

        if (!this.is('{')) {
            this.pos = start;
            return null;
        }

        const kind = kindToken.text as DeclKind;
        const decl: Declaration = {
            kind,
            name: nameToken.text,
            isStatic,
            range: this.rangeOf(first, nameToken),
            selectionRange: this.rangeOf(nameToken, nameToken),
            fields: [],
            pins: [],
            doc: cleanDoc(doc),
            children: [],
            sections: [],
        };

        this.advance(); // '{'
        const last = this.scanBody(decl);
        decl.range = this.rangeOf(first, last);
        return decl;
    }

    /** Walks a declaration body to its closing brace. Returns the last token. */
    private scanBody(decl: Declaration): Token {
        let depth = 1;
        let pendingDoc: string[] = [];
        let last = this.cur;

        while (!this.atEnd() && depth > 0) {
            if (this.atComment()) {
                pendingDoc.push(this.advance().text);
                continue;
            }

            // A render section marker (spec 4.7). Whole-line, so it can never
            // be half a statement; recorded for a block, whose body is the one
            // place the language allows it, and stepped over anywhere else --
            // the compiler owns the error, the index just must not trip on it.
            if (this.atSectionMarker()) {
                const marker = this.advance();
                const title = marker.text.slice(3).trim();
                if (depth === 1 && decl.kind === 'block' && title) {
                    decl.sections.push({ title, range: this.rangeOf(marker, marker) });
                }
                last = marker;
                pendingDoc = [];
                continue;
            }

            if (this.is('}')) {
                depth--;
                last = this.advance();
                continue;
            }
            if (this.is('{')) {
                depth++;
                this.advance();
                continue;
            }

            // A nested declaration: a block body may contain items, and a match
            // group may contain another.
            if (depth === 1) {
                const nested = this.tryDeclaration(pendingDoc);
                if (nested) {
                    decl.children.push(nested);
                    pendingDoc = [];
                    continue;
                }
            }

            if (depth === 1 && (this.is('#') || this.is('@') || this.is('>'))) {
                const field = this.tryField();
                if (field) {
                    decl.fields.push(field);
                    pendingDoc = [];
                    continue;
                }
            }

            // A pin map line, which only appears in a part body.
            if (depth === 1 && decl.kind === 'part') {
                const pin = this.tryPin();
                if (pin) {
                    decl.pins.push(pin);
                    pendingDoc = [];
                    continue;
                }
            }

            if (this.tryInstantiation()) {
                last = this.tokens[this.pos - 1];
                pendingDoc = [];
                continue;
            }

            last = this.advance();
            pendingDoc = [];
        }
        return last;
    }

    /** `[>] ('#'|'@') ['~'|'!'] name ['>'] '=' value ';'` */
    private tryField(): Field | null {
        const start = this.pos;
        const first = this.cur;

        let direction: Field['direction'] = 'local';
        if (this.is('>')) {
            direction = 'import';
            this.advance();
        }

        if (!this.is('#') && !this.is('@')) {
            this.pos = start;
            return null;
        }
        const namespace = this.advance().text as '@' | '#';

        let strength: Field['strength'] = '';
        if (this.is('~') || this.is('!')) strength = this.advance().text as '~' | '!';

        // Canonical export order writes the arrow before the name.
        if (this.is('>')) {
            direction = 'export';
            this.advance();
        }

        if (this.cur.kind !== TokenKind.Word) {
            this.pos = start;
            return null;
        }
        const name = this.advance().text;

        if (this.is('>')) {
            direction = 'export';
            this.advance();
        }

        if (!this.is('=')) {
            this.pos = start;
            return null;
        }
        this.advance();

        const valueStart = this.cur;
        let last = valueStart;
        while (!this.atEnd() && !this.is(';')) {
            if (this.atComment()) {
                this.advance();
                continue;
            }
            last = this.advance();
        }
        const value = this.text.slice(valueStart.start, last.end).trim();
        if (this.is(';')) last = this.advance();

        return { namespace, strength, name, value, direction, range: this.rangeOf(first, last) };
    }

    /** `(integer | '[' a ':' b ']') '=' logical [arrow] {directive|field} ';'` */
    private tryPin(): Pin | null {
        const start = this.pos;
        const first = this.cur;

        let physical: string;
        let count = 1;

        if (this.is('[')) {
            const open = this.advance();
            const lo = this.cur;
            if (lo.kind !== TokenKind.Word || !/^\d+$/.test(lo.text)) {
                this.pos = start;
                return null;
            }
            this.advance();
            if (!this.is(':')) {
                this.pos = start;
                return null;
            }
            this.advance();
            const hi = this.cur;
            if (hi.kind !== TokenKind.Word || !/^\d+$/.test(hi.text)) {
                this.pos = start;
                return null;
            }
            this.advance();
            if (!this.is(']')) {
                this.pos = start;
                return null;
            }
            const close = this.advance();
            physical = this.text.slice(open.start, close.end);
            count = Math.abs(Number(hi.text) - Number(lo.text)) + 1;
        } else if (this.cur.kind === TokenKind.Word && /^\d+$/.test(this.cur.text)) {
            physical = this.advance().text;
        } else {
            this.pos = start;
            return null;
        }

        if (!this.is('=')) {
            this.pos = start;
            return null;
        }
        this.advance();

        // The logical name runs until an arrow, a directive, a field or ';'.
        const logicalStart = this.cur;
        let logicalEnd = logicalStart;
        while (
            !this.atEnd() &&
            !this.is(';') &&
            !this.is('&') &&
            !this.is('#') &&
            !this.is('@') &&
            !this.is('<') &&
            !this.is('>') &&
            !this.is('<>')
        ) {
            if (this.atComment()) {
                this.advance();
                continue;
            }
            logicalEnd = this.advance();
        }
        const logical = this.text.slice(logicalStart.start, logicalEnd.end).trim();

        let arrow = '';
        while (this.is('<') || this.is('>') || this.is('<>')) arrow += this.advance().text;

        const directives: string[] = [];
        const fields: string[] = [];
        let last = logicalEnd;

        while (!this.atEnd() && !this.is(';')) {
            if (this.atComment()) {
                this.advance();
                continue;
            }
            if (this.is('&') || this.is('#') || this.is('@')) {
                const sigil = this.cur.text;
                const from = this.advance();
                let to = from;
                while (
                    !this.atEnd() &&
                    !this.is(';') &&
                    !this.is('&') &&
                    !this.is('#') &&
                    !this.is('@')
                ) {
                    if (this.atComment()) {
                        this.advance();
                        continue;
                    }
                    to = this.advance();
                }
                const written = this.text.slice(from.start, to.end).replace(/\s+/g, '');
                (sigil === '&' ? directives : fields).push(written);
                last = to;
                continue;
            }
            last = this.advance();
        }
        if (this.is(';')) last = this.advance();

        return {
            physical,
            logical,
            arrow,
            directives,
            fields,
            count,
            range: this.rangeOf(first, last),
        };
    }
}

/** Strips '//' markers and leading asterisks, and trims blank edges. */
function cleanDoc(comments: string[]): string {
    const lines: string[] = [];
    for (const comment of comments) {
        if (comment.startsWith('//')) {
            lines.push(comment.slice(2).replace(/^ /, ''));
        } else {
            const body = comment.replace(/^\/\*+/, '').replace(/\*+\/$/, '');
            for (const line of body.split('\n')) {
                lines.push(line.replace(/^\s*\*? ?/, ''));
            }
        }
    }
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\n');
}

export function scan(text: string): ScanResult {
    const { tokens } = tokenize(text);
    return new Scanner(tokens, text).scan();
}

/** Every declaration in a result, nested ones included. */
export function flatten(decls: Declaration[]): Declaration[] {
    const out: Declaration[] = [];
    const walk = (list: Declaration[]) => {
        for (const d of list) {
            out.push(d);
            walk(d.children);
        }
    };
    walk(decls);
    return out;
}
