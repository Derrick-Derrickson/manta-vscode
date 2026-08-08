// The language server, end to end.
//
// The other tests exercise the scanner, the index and the renderer directly.
// This one spawns the compiled server as a real child process and talks LSP to
// it over stdio, which is the only way to catch the wiring: a capability that is
// never advertised, a handler registered under the wrong method name, a request
// that throws. None of that shows up in a unit test.

import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'out', 'server', 'src', 'server.js');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'parts.manta');
const FIXTURE_URI = 'file:///workspace/parts.manta';

// ---------------------------------------------------------------------------
// A minimal LSP client
// ---------------------------------------------------------------------------

class Client {
    private readonly child: ChildProcess;
    private buffer = Buffer.alloc(0);
    private nextId = 1;
    private readonly pending = new Map<number, (r: { result?: unknown; error?: unknown }) => void>();

    constructor() {
        this.child = spawn(process.execPath, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.child.stdout!.on('data', (chunk: Buffer) => this.consume(chunk));
        // A server that crashes says so on stderr; surfacing it turns a silent
        // timeout into a readable failure.
        this.child.stderr!.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    }

    private consume(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);

        for (;;) {
            const headerEnd = this.buffer.indexOf('\r\n\r\n');
            if (headerEnd < 0) return;

            const header = this.buffer.subarray(0, headerEnd).toString('ascii');
            const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
            const bodyStart = headerEnd + 4;
            if (!Number.isFinite(length) || this.buffer.length < bodyStart + length) return;

            const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
            this.buffer = this.buffer.subarray(bodyStart + length);

            const message = JSON.parse(body) as { id?: number; result?: unknown; error?: unknown };
            if (typeof message.id === 'number') {
                this.pending.get(message.id)?.(message);
                this.pending.delete(message.id);
            }
        }
    }

    private write(message: object): void {
        const body = Buffer.from(JSON.stringify(message), 'utf8');
        this.child.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
        this.child.stdin!.write(body);
    }

    request<T>(method: string, params?: unknown): Promise<T> {
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000);
            this.pending.set(id, (message) => {
                clearTimeout(timer);
                if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
                else resolve(message.result as T);
            });
            this.write({ jsonrpc: '2.0', id, method, params });
        });
    }

    notify(method: string, params?: unknown): void {
        this.write({ jsonrpc: '2.0', method, params });
    }

    stop(): void {
        this.child.kill();
    }
}

let client: Client;
let capabilities: Record<string, unknown>;

before(async () => {
    client = new Client();
    const result = await client.request<{ capabilities: Record<string, unknown> }>('initialize', {
        processId: process.pid,
        rootUri: 'file:///workspace',
        capabilities: {},
    });
    capabilities = result.capabilities;
    client.notify('initialized', {});

    await client.request('manta/indexFiles', {
        files: [{ uri: FIXTURE_URI, text: readFileSync(FIXTURE, 'utf8') }],
    });
});

after(() => client?.stop());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('the server starts and advertises what it implements', () => {
    assert.ok(capabilities.hoverProvider, 'hover was not advertised');
    assert.ok(capabilities.definitionProvider, 'definition was not advertised');
    assert.ok(capabilities.documentSymbolProvider, 'document symbols were not advertised');
    assert.ok(capabilities.workspaceSymbolProvider, 'workspace symbols were not advertised');
});

test('the parts request returns the workspace index', async () => {
    interface Entry {
        name: string;
        kind: string;
        uri: string;
        pinCount: number;
        instantiations: number;
    }
    const parts = await client.request<Entry[]>('manta/parts');

    const mcu = parts.find((p) => p.name === 'MCU-48');
    assert.ok(mcu, `MCU-48 missing from ${JSON.stringify(parts.map((p) => p.name))}`);
    assert.equal(mcu.kind, 'part');
    assert.equal(mcu.uri, FIXTURE_URI);
    assert.equal(mcu.pinCount, 52);

    assert.ok(parts.some((p) => p.name === 'top' && p.kind === 'block'));
    assert.ok(parts.some((p) => p.name === 'i2c-bus' && p.kind === 'harness'));

    // The datasheet below the '---' marker contains "block not-a-block {".
    assert.ok(!parts.some((p) => p.name === 'not-a-block'), 'documentation was indexed as code');
});

test('describe renders a card for a part from an unopened file', async () => {
    // Nothing sent didOpen; the index came from manta/indexFiles alone. This is
    // the case a hover would silently fail on if the client were the only
    // source of documents.
    const card = await client.request<string | null>('manta/describe', { name: 'MCU-48' });
    assert.ok(card, 'no card was returned');
    assert.match(card, /STM32F0QA5/);
    assert.match(card, /52 pins/);
});

test('describe returns nothing for a name that is not declared', async () => {
    assert.equal(await client.request('manta/describe', { name: 'NO-SUCH-PART' }), null);
});

test('hovering an instantiation explains the part being instantiated', async () => {
    const text = readFileSync(FIXTURE, 'utf8');
    client.notify('textDocument/didOpen', {
        textDocument: { uri: FIXTURE_URI, languageId: 'manta', version: 1, text },
    });

    // The '~AMP012' inside block top.
    const lines = text.split('\n');
    const line = lines.findIndex((l) => l.includes('~AMP012'));
    assert.ok(line >= 0);

    const hover = await client.request<{ contents: { value: string } } | null>(
        'textDocument/hover',
        {
            textDocument: { uri: FIXTURE_URI },
            position: { line, character: lines[line].indexOf('AMP012') + 2 },
        },
    );

    // AMP012 is instantiated but never declared in this workspace, so the
    // honest answer is nothing rather than an invented card.
    assert.equal(hover, null);
});

test('hovering a declared part name gives its card', async () => {
    const lines = readFileSync(FIXTURE, 'utf8').split('\n');
    const line = lines.findIndex((l) => l.startsWith('part MCU-48'));
    assert.ok(line >= 0);

    const hover = await client.request<{ contents: { value: string } } | null>(
        'textDocument/hover',
        {
            textDocument: { uri: FIXTURE_URI },
            position: { line, character: lines[line].indexOf('MCU-48') + 1 },
        },
    );

    assert.ok(hover, 'no hover at the declaration');
    assert.match(hover.contents.value, /LQFP-48/);
});

test('document symbols cover every declaration in the file', async () => {
    interface Symbol {
        name: string;
        children?: Symbol[];
    }
    const symbols = await client.request<Symbol[]>('textDocument/documentSymbol', {
        textDocument: { uri: FIXTURE_URI },
    });

    const names = symbols.map((s) => s.name);
    for (const expected of ['MCU-48', 'R-10k-1pct-0603', 'i2c-bus', 'power', 'ddr-addr', 'top']) {
        assert.ok(names.includes(expected), `${expected} missing from ${JSON.stringify(names)}`);
    }
});

test('workspace symbols answer a partial name', async () => {
    const symbols = await client.request<{ name: string }[]>('workspace/symbol', { query: 'MCU' });
    assert.ok(symbols.some((s) => s.name === 'MCU-48'));
});

test('go to definition jumps from an instantiation to the declaration', async () => {
    const lines = readFileSync(FIXTURE, 'utf8').split('\n');
    const use = lines.findIndex((l) => l.includes('U1~MCU-48'));
    const declaration = lines.findIndex((l) => l.startsWith('part MCU-48'));
    assert.ok(use >= 0 && declaration >= 0, 'the fixture lost its MCU-48 instantiation');

    const location = await client.request<{ uri: string; range: { start: { line: number } } } | null>(
        'textDocument/definition',
        {
            textDocument: { uri: FIXTURE_URI },
            position: { line: use, character: lines[use].indexOf('MCU-48') + 1 },
        },
    );

    assert.ok(location, 'no definition found');
    assert.equal(location.uri, FIXTURE_URI);
    assert.equal(location.range.start.line, declaration);
});

test('removing a file removes its declarations', async () => {
    await client.request('manta/removeFile', { uri: FIXTURE_URI });
    const parts = await client.request<{ name: string }[]>('manta/parts');
    assert.ok(!parts.some((p) => p.name === 'MCU-48'), 'a removed file was still indexed');
});
