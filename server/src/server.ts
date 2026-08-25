// SPDX-FileCopyrightText: 2026 Tom
// SPDX-License-Identifier: GPL-3.0-or-later
// The manta language server.
//
// It owns the index. The editor asks it for hovers and definitions through the
// standard protocol, and for the parts tree through one custom request -- a
// tree view is a VS Code idea with no LSP equivalent, so the client renders it
// but the server still decides what is in it. Keeping the index in one place is
// what stops the tree and the hover ever disagreeing.

import {
    CompletionItem,
    CompletionItemKind,
    createConnection,
    DidChangeConfigurationNotification,
    DocumentSymbol,
    Hover,
    InitializeParams,
    InitializeResult,
    Location,
    MarkupKind,
    ProposedFeatures,
    SymbolKind,
    TextDocumentSyncKind,
    TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from './uri';

import { describe, summarise } from './describe';
import { computeInline } from './inline';
import { IndexStore, Located } from './index-store';
import { Declaration, DeclKind, Range as ScanRange, scan } from './scanner';
import { wordAt } from './word';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const store = new IndexStore();

/** Files the client found on disk, so the index covers more than open tabs. */
let workspaceScanned = false;

const SYMBOL_KIND: Record<DeclKind, SymbolKind> = {
    part: SymbolKind.Class,
    block: SymbolKind.Module,
    harness: SymbolKind.Interface,
    netclass: SymbolKind.Namespace,
    match: SymbolKind.Event,
    cable: SymbolKind.Struct,
};

function toLspRange(r: ScanRange) {
    return {
        start: { line: r.startLine, character: r.startCharacter },
        end: { line: r.endLine, character: r.endCharacter },
    };
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
    void params;
    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            hoverProvider: true,
            definitionProvider: true,
            documentSymbolProvider: true,
            workspaceSymbolProvider: true,
            completionProvider: { triggerCharacters: ['~'] },
        },
    };
});

connection.onInitialized(() => {
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
});

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

function reindex(document: TextDocument): void {
    const changed = store.update(document.uri, document.getText(), document.version);
    if (changed) connection.sendNotification('manta/indexChanged');
}

documents.onDidOpen((event) => reindex(event.document));
documents.onDidChangeContent((event) => reindex(event.document));
documents.onDidClose((event) => {
    // A closed file is still part of the workspace, so its declarations stay
    // in the index; only an unsaved buffer's edits are dropped, and the client
    // re-sends the file's contents from disk.
    void event;
});

/**
 * The client hands over every `.manta` file it found, so the index is complete
 * before a tab is opened. The server cannot glob the workspace itself without
 * assuming a filesystem, and a client that runs in a browser has none.
 */
connection.onRequest(
    'manta/indexFiles',
    // An object, not the bare array: JSON-RPC treats an array of parameters as
    // positional arguments, so a request sent as a list arrives as its first
    // element and the index silently covers one file.
    ({ files }: { files: { uri: string; text: string }[] }): { indexed: number } => {
        for (const file of files) {
            if (!documents.get(file.uri)) store.update(file.uri, file.text);
        }
        workspaceScanned = true;
        connection.sendNotification('manta/indexChanged');
        return { indexed: store.size };
    },
);

connection.onRequest('manta/removeFile', ({ uri }: { uri: string }) => {
    store.remove(uri);
    connection.sendNotification('manta/indexChanged');
});

// ---------------------------------------------------------------------------
// The parts tree
// ---------------------------------------------------------------------------

export interface PartsEntry {
    name: string;
    kind: DeclKind;
    isStatic: boolean;
    detail: string;
    uri: string;
    range: ReturnType<typeof toLspRange>;
    selectionRange: ReturnType<typeof toLspRange>;
    pinCount: number;
    instantiations: number;
}

connection.onRequest('manta/parts', (): PartsEntry[] => {
    return store.all().map(({ declaration, uri }) => ({
        name: declaration.name,
        kind: declaration.kind,
        isStatic: declaration.isStatic,
        detail: summarise(declaration),
        uri,
        range: toLspRange(declaration.range),
        selectionRange: toLspRange(declaration.selectionRange),
        pinCount: declaration.pins.reduce((n, p) => n + p.count, 0),
        instantiations: store.instantiations(declaration.name),
    }));
});

connection.onRequest('manta/inline', ({ uri }: { uri: string }) => {
    const document = documents.get(uri);
    if (!document) return null;
    return computeInline(document.getText(), (partName) => {
        const found = store.lookup(partName, uri);
        if (!found || found.declaration.kind !== 'part') return undefined;
        const value = found.declaration.fields.find((f) => f.name === 'value');
        return value?.value;
    });
});

connection.onRequest('manta/describe', ({ name }: { name: string }): string | null => {
    const found = store.lookup(name);
    if (!found) return null;
    return describe(found.declaration, {
        instantiations: store.instantiations(name),
        location: URI.basename(found.uri),
    });
});

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

connection.onHover((params): Hover | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const word = wordAt(document.getText(), document.offsetAt(params.position));
    if (!word) return null;

    const found = store.lookup(word.text, document.uri);
    if (!found) return null;

    // Do not explain a declaration to itself: hovering the name in
    // "part cool-mcu {" should say something, but repeating the card the reader
    // is already looking at is noise. It still shows, because the instantiation
    // count and the pin summary are not otherwise visible from there.
    const sameFile = found.uri === document.uri;
    const location = sameFile ? undefined : URI.basename(found.uri);

    return {
        contents: {
            kind: MarkupKind.Markdown,
            value: describe(found.declaration, {
                instantiations: store.instantiations(word.text),
                location,
            }),
        },
        range: {
            start: document.positionAt(word.start),
            end: document.positionAt(word.end),
        },
    };
});

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

connection.onDefinition((params): Location | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const word = wordAt(document.getText(), document.offsetAt(params.position));
    if (!word) return null;

    const found = store.lookup(word.text, document.uri);
    if (!found) return null;

    return { uri: found.uri, range: toLspRange(found.declaration.selectionRange) };
});

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

function toDocumentSymbol(decl: Declaration): DocumentSymbol {
    // A render section (spec 4.7) is purely presentational, but it is also how
    // the author chose to caption the block, so the outline shows the captions
    // under it. The symbol spans only the marker line: sections do not own the
    // statements after them the way a declaration owns its body, and a symbol
    // that pretended otherwise would fight the declaration ranges around it.
    const sections: DocumentSymbol[] = decl.sections.map((section) => ({
        name: section.title,
        kind: SymbolKind.String,
        range: toLspRange(section.range),
        selectionRange: toLspRange(section.range),
    }));

    return {
        name: decl.name,
        detail: summarise(decl),
        kind: SYMBOL_KIND[decl.kind],
        range: toLspRange(decl.range),
        selectionRange: toLspRange(decl.selectionRange),
        children: [...decl.children.map(toDocumentSymbol), ...sections].sort(
            (a, b) =>
                a.range.start.line - b.range.start.line ||
                a.range.start.character - b.range.start.character,
        ),
    };
}

connection.onDocumentSymbol((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];
    // Scanned fresh rather than read from the index, so the outline tracks an
    // unsaved buffer keystroke by keystroke.
    return scan(document.getText()).declarations.map(toDocumentSymbol);
});

connection.onWorkspaceSymbol((params) => {
    const query = params.query.toLowerCase();
    return store
        .all()
        .filter(({ declaration }) => declaration.name.toLowerCase().includes(query))
        .map(({ declaration, uri }) => ({
            name: declaration.name,
            kind: SYMBOL_KIND[declaration.kind],
            location: { uri, range: toLspRange(declaration.selectionRange) },
        }));
});

// ---------------------------------------------------------------------------
// Completion after '~', where a part or block name goes
// ---------------------------------------------------------------------------

connection.onCompletion((params): CompletionItem[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];

    const offset = document.offsetAt(params.position);
    const text = document.getText();

    // Only after a '~', which is where a name binds an instance to a part or a
    // block. Offering every declaration everywhere would be noise.
    let i = offset - 1;
    while (i >= 0 && /[A-Za-z0-9_\-]/.test(text[i])) i--;
    if (i < 0 || text[i] !== '~') return [];

    const candidates: Located[] = store
        .all()
        .filter(({ declaration }) => declaration.kind === 'part' || declaration.kind === 'block');

    return candidates.map(({ declaration, uri }) => ({
        label: declaration.name,
        kind: declaration.kind === 'part' ? CompletionItemKind.Class : CompletionItemKind.Module,
        detail: summarise(declaration),
        documentation: {
            kind: MarkupKind.Markdown,
            value: describe(declaration, { maxPins: 8, location: URI.basename(uri) }),
        },
    }));
});

// ---------------------------------------------------------------------------

connection.onRequest('manta/status', () => ({
    files: store.size,
    declarations: store.all().length,
    workspaceScanned,
}));

documents.listen(connection);
connection.listen();
