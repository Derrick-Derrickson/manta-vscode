// SPDX-FileCopyrightText: 2026 Tom
// SPDX-License-Identifier: GPL-3.0-or-later
// A tokenizer for manta source.
//
// Deliberately not a reimplementation of the compiler's lexer, and it does not
// try to be. It classifies enough to walk a file's structure without being
// fooled by a comment, a string, or a datasheet: those three are what defeat a
// regex, and they are the whole reason this exists.
//
// Where the compiler must decide between readings of an ambiguous word, this
// records the ambiguity and lets the scanner pick by position, the same way the
// compiler's parser does.

export const enum TokenKind {
    Word,
    String,
    Comment,
    Punct,
    EndOfContent, // the '---' marker
    EndOfFile,
}

export interface Token {
    kind: TokenKind;
    /** The exact source text. */
    text: string;
    /** Byte offset in the document. */
    start: number;
    end: number;
    line: number;
    /** Column in UTF-16 code units, which is what the editor counts in. */
    character: number;
}

const isDigit = (c: string) => c >= '0' && c <= '9';
const isLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isWordStart = (c: string) => isLetter(c) || isDigit(c) || c === '_';
const isWordBody = (c: string) => isWordStart(c) || c === '-';

/** Multi-character punctuation, longest first so that '==' beats '='. */
const PUNCT = ['<>', '>>', '==', '=*', '*=', '<=', '>=', '!=', '+-'];

export interface LexResult {
    tokens: Token[];
    /** Offset of the end-of-content marker, or -1. Everything after is not manta. */
    contentEnd: number;
}

export function tokenize(text: string): LexResult {
    const tokens: Token[] = [];
    let i = 0;
    let line = 0;
    let lineStart = 0;
    let braceDepth = 0;
    let contentEnd = -1;

    const push = (kind: TokenKind, start: number, end: number) => {
        tokens.push({
            kind,
            text: text.slice(start, end),
            start,
            end,
            line,
            character: start - lineStart,
        });
    };

    const atLineStart = () => i === 0 || text[i - 1] === '\n';

    while (i < text.length) {
        const c = text[i];

        if (c === '\n') {
            i++;
            line++;
            lineStart = i;
            continue;
        }
        if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
            i++;
            continue;
        }

        // Spec 2.8: a line of exactly '---', outside any declaration, ends the
        // manta content of the file. Requiring depth zero is what keeps a stray
        // '---' inside a block the syntax error it already was.
        if (c === '-' && braceDepth === 0 && atLineStart() && text.startsWith('---', i)) {
            let j = i + 3;
            while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r')) j++;
            if (j >= text.length || text[j] === '\n') {
                push(TokenKind.EndOfContent, i, i + 3);
                contentEnd = i;
                break;
            }
        }

        if (c === '/' && text[i + 1] === '/') {
            const start = i;
            while (i < text.length && text[i] !== '\n') i++;
            push(TokenKind.Comment, start, i);
            continue;
        }

        if (c === '/' && text[i + 1] === '*') {
            const start = i;
            const startLine = line;
            const startLineStart = lineStart;
            i += 2;
            // Spec 2.5: block comments do not nest; the first '*/' closes it.
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
                if (text[i] === '\n') {
                    line++;
                    lineStart = i + 1;
                }
                i++;
            }
            if (i < text.length) i += 2;
            const saveLine = line;
            const saveLineStart = lineStart;
            line = startLine;
            lineStart = startLineStart;
            push(TokenKind.Comment, start, i);
            line = saveLine;
            lineStart = saveLineStart;
            continue;
        }

        if (c === '"') {
            const start = i;
            i++;
            while (i < text.length && text[i] !== '"' && text[i] !== '\n') {
                if (text[i] === '\\') i++;
                i++;
            }
            if (i < text.length && text[i] === '"') i++;
            push(TokenKind.String, start, i);
            continue;
        }

        // A word: maximal munch, with a '.' admitted only while a number is
        // being built. That is what keeps "4.7kR" and "0.2-1.2" whole while
        // stopping "U1.GPIO1" at the dot so member access still parses.
        if (isWordStart(c) || (c === '-' && isWordStart(text[i + 1] ?? ''))) {
            const start = i;
            if (text[i] === '-') i++;
            let runStart = i;
            while (i < text.length) {
                const ch = text[i];
                if (ch === '-') {
                    i++;
                    runStart = i;
                    continue;
                }
                if (isWordBody(ch)) {
                    i++;
                    continue;
                }
                if (ch === '.' && i > runStart && isDigit(text[i + 1] ?? '')) {
                    let numeric = true;
                    for (let k = runStart; k < i; k++) {
                        if (!isDigit(text[k])) {
                            numeric = false;
                            break;
                        }
                    }
                    if (numeric) {
                        i++;
                        continue;
                    }
                }
                break;
            }
            push(TokenKind.Word, start, i);
            continue;
        }

        const two = text.slice(i, i + 2);
        if (PUNCT.includes(two)) {
            push(TokenKind.Punct, i, i + 2);
            i += 2;
            continue;
        }

        if (c === '{') braceDepth++;
        if (c === '}' && braceDepth > 0) braceDepth--;
        push(TokenKind.Punct, i, i + 1);
        i++;
    }

    tokens.push({
        kind: TokenKind.EndOfFile,
        text: '',
        start: text.length,
        end: text.length,
        line,
        character: text.length - lineStart,
    });

    return { tokens, contentEnd };
}
