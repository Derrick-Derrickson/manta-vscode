// SPDX-FileCopyrightText: 2026 Tom
// SPDX-License-Identifier: GPL-3.0-or-later
// The workspace index: every declaration, and where it is.
//
// Manta has no file-level scope -- a file is a collection of named declarations
// and order is irrelevant -- so an index is exactly the right shape for it.
// A name resolves the same way from anywhere, which is what lets a hover in one
// file explain a part declared in another.
//
// No VS Code or LSP imports.

import { Declaration, ScanResult, flatten, scan } from './scanner';

export interface FileIndex {
    uri: string;
    version: number;
    result: ScanResult;
}

export interface Located {
    declaration: Declaration;
    uri: string;
}

export class IndexStore {
    private files = new Map<string, FileIndex>();

    /** Reindexes one file. Returns true if its declarations changed. */
    update(uri: string, text: string, version = 0): boolean {
        const before = this.files.get(uri);
        const result = scan(text);
        this.files.set(uri, { uri, version, result });

        if (!before) return true;
        return signature(before.result) !== signature(result);
    }

    remove(uri: string): void {
        this.files.delete(uri);
    }

    clear(): void {
        this.files.clear();
    }

    get size(): number {
        return this.files.size;
    }

    has(uri: string): boolean {
        return this.files.has(uri);
    }

    /** Every declaration in the workspace, nested ones included. */
    all(): Located[] {
        const out: Located[] = [];
        for (const file of this.files.values()) {
            for (const declaration of flatten(file.result.declarations)) {
                out.push({ declaration, uri: file.uri });
            }
        }
        // Sorted by name so the tree and every listing are stable between runs
        // regardless of the order the filesystem handed the files over.
        out.sort(
            (a, b) =>
                a.declaration.name.localeCompare(b.declaration.name) ||
                a.uri.localeCompare(b.uri),
        );
        return out;
    }

    /**
     * Resolves a name. A `static` declaration has internal linkage, so one in
     * the asking file wins over an external declaration of the same name.
     */
    lookup(name: string, fromUri?: string): Located | undefined {
        let external: Located | undefined;

        for (const file of this.files.values()) {
            for (const declaration of flatten(file.result.declarations)) {
                if (declaration.name !== name) continue;
                if (declaration.isStatic) {
                    if (file.uri === fromUri) return { declaration, uri: file.uri };
                    continue; // invisible from anywhere else
                }
                external ??= { declaration, uri: file.uri };
            }
        }
        return external;
    }

    /** How many times a name is instantiated across the workspace. */
    instantiations(name: string): number {
        let total = 0;
        for (const file of this.files.values()) {
            for (const use of file.result.instantiations) {
                if (use.name === name) total++;
            }
        }
        return total;
    }

    /** Declarations of one file, in source order. */
    forFile(uri: string): Declaration[] {
        const file = this.files.get(uri);
        return file ? flatten(file.result.declarations) : [];
    }

    /** Names declared more than once with external linkage -- the compiler's E-30. */
    duplicates(): Map<string, Located[]> {
        const byName = new Map<string, Located[]>();
        for (const located of this.all()) {
            if (located.declaration.isStatic) continue;
            const list = byName.get(located.declaration.name) ?? [];
            list.push(located);
            byName.set(located.declaration.name, list);
        }
        for (const [name, list] of byName) {
            if (list.length < 2) byName.delete(name);
        }
        return byName;
    }
}

/** A cheap fingerprint of what an index exposes, to skip needless refreshes. */
function signature(result: ScanResult): string {
    return flatten(result.declarations)
        .map((d) => `${d.kind}:${d.name}:${d.isStatic}:${d.pins.length}:${d.fields.length}`)
        .join('|');
}
