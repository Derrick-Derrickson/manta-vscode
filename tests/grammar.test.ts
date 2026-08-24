// SPDX-FileCopyrightText: 2026 Tom
// SPDX-License-Identifier: GPL-3.0-or-later
// Syntax highlighting, checked by running the real thing.
//
// These tests drive the same TextMate engine VS Code uses -- vscode-textmate
// over vscode-oniguruma -- across the grammars this extension ships, and assert
// the scope each piece of manta ends up in. A theme colours by scope, so if the
// scopes are right the colours are right, and this is as close to the editor as
// a test can get without one.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import * as oniguruma from 'vscode-oniguruma';
import { INITIAL, IGrammar, Registry, parseRawGrammar } from 'vscode-textmate';

const ROOT = join(__dirname, '..', '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const registry = (async () => {
    const wasm = readFileSync(join(ROOT, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'));
    await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

    return new Registry({
        onigLib: Promise.resolve({
            createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
            createOnigString: (s) => new oniguruma.OnigString(s),
        }),
        loadGrammar: async (scopeName) => {
            const file = { 'source.manta': 'manta', 'source.mantarules': 'mantarules' }[scopeName];
            if (!file) return null;
            const path = join(ROOT, 'syntaxes', `${file}.tmLanguage.json`);
            return parseRawGrammar(readFileSync(path, 'utf8'), path);
        },
    });
})();

const grammars = new Map<string, Promise<IGrammar>>();

function grammarFor(scopeName: string): Promise<IGrammar> {
    let g = grammars.get(scopeName);
    if (!g) {
        g = registry.then(async (r) => {
            const loaded = await r.loadGrammar(scopeName);
            assert.ok(loaded, `grammar ${scopeName} did not load`);
            return loaded;
        });
        grammars.set(scopeName, g);
    }
    return g;
}

interface Scoped {
    text: string;
    scopes: string[];
    line: number;
}

/** Every token of `text`, with the full scope stack on each. */
async function tokenize(text: string, scopeName = 'source.manta'): Promise<Scoped[]> {
    const grammar = await grammarFor(scopeName);
    const out: Scoped[] = [];
    let stack = INITIAL;

    text.split(/\r?\n/).forEach((line, n) => {
        const result = grammar.tokenizeLine(line, stack);
        for (const token of result.tokens) {
            const slice = line.substring(token.startIndex, token.endIndex);
            if (slice.trim() === '') continue;
            out.push({ text: slice, scopes: token.scopes, line: n });
        }
        stack = result.ruleStack;
    });

    return out;
}

/**
 * Tokens spelled exactly `text`.
 *
 * Trimmed, because a token's extent is the grammar's business: a run the
 * grammar did not name arrives with its surrounding spaces attached, and a test
 * that broke on that would be testing whitespace rather than scopes.
 */
function tokensSpelled(tokens: Scoped[], text: string): Scoped[] {
    return tokens.filter((t) => t.text.trim() === text);
}

/** The scopes given to the first token spelled `text`. */
function scopesOf(tokens: Scoped[], text: string): string[] {
    const [token] = tokensSpelled(tokens, text);
    assert.ok(token, `no token with the text ${JSON.stringify(text)}`);
    return token.scopes;
}

function matcher(scope: string | RegExp): (s: string) => boolean {
    return (s) => (typeof scope === 'string' ? s === scope : scope.test(s));
}

/** Assert that some token spelled `text` carries a scope matching `scope`. */
function assertScope(tokens: Scoped[], text: string, scope: string | RegExp): void {
    const matches = tokensSpelled(tokens, text);
    assert.ok(matches.length > 0, `no token with the text ${JSON.stringify(text)}`);

    const hit = matches.some((t) => t.scopes.some(matcher(scope)));
    assert.ok(
        hit,
        `${JSON.stringify(text)} has scopes ${JSON.stringify(matches.map((m) => m.scopes))},` +
            ` none matching ${scope}`,
    );
}

/**
 * Assert that the token containing `text` carries a scope matching `scope`.
 *
 * For spans the grammar deliberately does not subdivide -- a comment's body,
 * the text after the end-of-content marker -- where the interesting claim is
 * about the whole run, not one word of it.
 */
function assertScopeContaining(tokens: Scoped[], text: string, scope: string | RegExp): void {
    const matches = tokens.filter((t) => t.text.includes(text));
    assert.ok(matches.length > 0, `no token containing ${JSON.stringify(text)}`);

    const hit = matches.some((t) => t.scopes.some(matcher(scope)));
    assert.ok(
        hit,
        `no run containing ${JSON.stringify(text)} matches ${scope};` +
            ` found ${JSON.stringify(matches.map((m) => [m.text, m.scopes]))}`,
    );
}

// ---------------------------------------------------------------------------
// The grammars load at all
// ---------------------------------------------------------------------------

test('both grammars load and are valid TextMate', async () => {
    assert.ok(await grammarFor('source.manta'));
    assert.ok(await grammarFor('source.mantarules'));
});

test('nothing in the sample file is left unscoped', async () => {
    // Every token carries at least the root scope. A token with no scope at all
    // means a pattern matched and named nothing, which shows as unthemed text.
    const tokens = await tokenize(readFileSync(join(FIXTURES, 'parts.manta'), 'utf8'));
    for (const token of tokens) {
        assert.ok(token.scopes.length > 0, `line ${token.line}: ${token.text} has no scope`);
        assert.equal(token.scopes[0], 'source.manta');
    }
});

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

test('a declaration keyword and its name are distinguished', async () => {
    const tokens = await tokenize('part MCU-48 {\n};');
    assertScope(tokens, 'part', 'keyword.declaration.manta');
    assertScope(tokens, 'MCU-48', 'entity.name.type.manta');
});

test('static reads as a linkage modifier', async () => {
    const tokens = await tokenize('static part R-10k {\n};');
    assertScope(tokens, 'static', 'storage.modifier.linkage.manta');
    assertScope(tokens, 'part', 'keyword.declaration.manta');
    assertScope(tokens, 'R-10k', 'entity.name.type.manta');
});

test('every declaration kind is a keyword', async () => {
    for (const kind of ['block', 'part', 'harness', 'netclass', 'match', 'cable']) {
        const tokens = await tokenize(`${kind} thing {\n};`);
        assertScope(tokens, kind, 'keyword.declaration.manta');
        assertScope(tokens, 'thing', 'entity.name.type.manta');
    }
});

test('a word that merely contains a keyword is not one', async () => {
    const tokens = await tokenize('X = .{R1~partial-match}. = Y;');
    assert.ok(
        !scopesOf(tokens, 'partial-match').includes('keyword.declaration.manta'),
        'the "part" inside "partial-match" was highlighted as a keyword',
    );
});

// ---------------------------------------------------------------------------
// Fields and directives: the two namespaces
// ---------------------------------------------------------------------------

test('the system and user namespaces are both fields, and both marked', async () => {
    const tokens = await tokenize('part p {\n    @~footprint = R-0603;\n    #value = 10kR;\n};');
    assertScope(tokens, '@', 'punctuation.definition.field.manta');
    assertScope(tokens, '#', 'punctuation.definition.field.manta');
    assertScope(tokens, 'footprint', 'variable.other.field.manta');
    assertScope(tokens, 'value', 'variable.other.field.manta');
});

test('a strength modifier is scoped apart from the field name', async () => {
    const tokens = await tokenize('part p {\n    #!manufacturer = "ST";\n    @~footprint = F;\n};');
    // Both '~' and '!' are strength; the one on the '!' line proves the
    // override marker is not swallowed into the name.
    assertScope(tokens, '!', 'storage.modifier.strength.manta');
    assertScope(tokens, '~', 'storage.modifier.strength.manta');
    assertScope(tokens, 'manufacturer', 'variable.other.field.manta');
});

test('an import and an export arrow are distinguished', async () => {
    const imported = await tokenize('part p {\n    >#~source = digikey;\n};');
    assertScope(imported, '>', 'keyword.operator.import.manta');

    const exported = await tokenize('block b {\n    #~gain> = 4;\n};');
    assertScope(exported, '>', 'keyword.operator.export.manta');
});

test('a known directive reads as a known one', async () => {
    const tokens = await tokenize('block b {\n    A = B &CURRENT=3A &!VOLTAGE=6V;\n};');
    assertScope(tokens, '&', 'punctuation.definition.directive.manta');
    assertScope(tokens, 'CURRENT', 'support.type.directive.manta');
    assertScope(tokens, 'VOLTAGE', 'support.type.directive.manta');
    assertScope(tokens, '!', 'storage.modifier.strength.manta');
});

test('an unknown directive is still a directive, not an error', async () => {
    // The '&' namespace is closed, but a grammar that painted every unknown
    // name red would fight the compiler rather than help it -- the compiler is
    // the authority on which names exist.
    const tokens = await tokenize('block b {\n    A = B &MADE-UP=1;\n};');
    const scopes = scopesOf(tokens, 'MADE-UP');
    assert.ok(scopes.some((s) => s.startsWith('entity.name.function.directive')));
    assert.ok(!scopes.some((s) => s.startsWith('invalid')));
});

test('a pin type is a language constant', async () => {
    const tokens = await tokenize('part p {\n    1 = VCC< &TYPE=POWER;\n    2 = NC &TYPE=NC;\n};');
    assertScope(tokens, 'POWER', 'constant.language.pintype.manta');
});

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

test('an area is one token, and its prefix squares with it', async () => {
    // Longest-first matters: with 'm' tried before 'm2', '1mm2' would colour as
    // '1mm' followed by a stray digit.
    for (const value of ['1mm2', '0.5mm2', '2m2', '350000um2']) {
        const tokens = await tokenize(`part p {\n    #csa = ${value};\n};`);
        assertScope(tokens, value, 'constant.numeric.dimensioned.manta');
    }
    // A length is still a length.
    const lengths = await tokenize('part p {\n    #len = 5mm;\n};');
    assertScope(lengths, '5mm', 'constant.numeric.dimensioned.manta');
});

test("'m' takes no point-substituted spelling, because it is also a prefix", async () => {
    // 'm' is the only unit that is also an SI prefix, so the compiler reads
    // '5m5' as five milli-something with no unit left and rejects it. Every
    // other unit accepts the form: '3V3' is 3.3 volts.
    for (const notAValue of ['5m5', '1m23']) {
        const tokens = await tokenize(`part p {\n    #x = ${notAValue};\n};`);
        assert.ok(
            !scopesOf(tokens, notAValue).some((sc) => sc.startsWith('constant.numeric')),
            `${notAValue} was coloured as a value the compiler rejects`,
        );
    }
    const ok = await tokenize('part p {\n    #x = 3V3;\n};');
    assertScope(ok, '3V3', 'constant.numeric.dimensioned.manta');
});

test('a range inside a list is a range, not punctuation', async () => {
    const tokens = await tokenize('part p {\n    @map = [[1:8],[8:1]];\n};');
    assertScope(tokens, '1', 'constant.numeric.range.manta');
    assertScope(tokens, '8', 'constant.numeric.range.manta');
    assertScope(tokens, ':', 'punctuation.separator.range.manta');
});

test('a colon outside a list is still a binding separator', async () => {
    // ':' separates a binding list from a device; reading it as a range there
    // would recolour every call site in the language.
    const tokens = await tokenize('block b {\n    X = .{U1~P: EN=GND; }. = Y;\n};');
    assertScope(tokens, ':', 'punctuation.separator.binding.manta');
});

test('both spellings of a dimensioned value are one numeric token', async () => {
    for (const value of ['4.7kR', '4k7R', '3V3', '100nF', '25mA', '1R5', '5ps', '2V4']) {
        const tokens = await tokenize(`part p {\n    #value = ${value};\n};`);
        assertScope(tokens, value, 'constant.numeric.dimensioned.manta');
    }
});

test('a tolerance is a value in either spelling', async () => {
    for (const tolerance of ['±1%', '+-5%']) {
        const tokens = await tokenize(`part p {\n    #tolerance = ${tolerance};\n};`);
        assertScope(tokens, tolerance, 'constant.numeric.tolerance.manta');
    }
});

test('an imperial value is marked illegal', async () => {
    // Spec 3.4: manta is metric only. The editor can say so before the
    // compiler is ever run.
    for (const value of ['5mil', '0.5inch', '2ft']) {
        const tokens = await tokenize(`part p {\n    #clearance = ${value};\n};`);
        assertScope(tokens, value, 'invalid.illegal.imperial-unit.manta');
    }
});

test('a trailing hyphen is marked illegal', async () => {
    // Spec 2.3. This is the rule the spec's own examples got wrong, so it is
    // worth catching in the editor.
    const tokens = await tokenize('block b {\n    V- = GND;\n};');
    assertScope(tokens, 'V-', 'invalid.illegal.trailing-hyphen.manta');
});

test('a hyphen inside an identifier is not a trailing hyphen', async () => {
    const tokens = await tokenize('block b {\n    X = .{R1~R-10k-1pct-0603}. = Y;\n};');
    assert.ok(
        !scopesOf(tokens, 'R-10k-1pct-0603').some((s) => s.startsWith('invalid')),
        'a legal hyphenated part name was flagged',
    );
});

test('a value in a name is not mistaken for a literal', async () => {
    // "R-0603" ends in digits but is a footprint name, and "MT100UFA" contains
    // a number. Neither is a quantity.
    const tokens = await tokenize('part p {\n    @~footprint = R-0603;\n};');
    assert.ok(!scopesOf(tokens, 'R-0603').some((s) => s.startsWith('constant.numeric')));
});

// ---------------------------------------------------------------------------
// Instances and connectors
// ---------------------------------------------------------------------------

test('an instantiation names the part being instantiated', async () => {
    const tokens = await tokenize('block b {\n    X = .{R1~R-10k-0603}. = GND;\n};');
    // The designator splits: the prefix names the class of part, the number is
    // the annotation, and a theme can colour a "?" the same as a "1".
    assertScope(tokens, 'R', 'variable.other.designator.manta');
    assertScope(tokens, '1', 'constant.numeric.designator.manta');
    assertScope(tokens, '~', 'keyword.operator.instantiate.manta');
    assertScope(tokens, 'R-10k-0603', 'entity.name.type.instantiated.manta');
});

test('an unassigned designator and a do-not-populate marker are marked', async () => {
    const tokens = await tokenize('block b {\n    X = .{!R?~0R-0603}. = GND;\n};');
    assertScope(tokens, '!', 'keyword.operator.dnp.manta');
    assertScope(tokens, '?', 'constant.numeric.designator.manta');
});

test('a pin declaration maps with a colon (revision 1.6)', async () => {
    const tokens = await tokenize('part p {\n    5: SDA<>;\n    [1:4]: IO[1:4]<>;\n};');
    assertScope(tokens, '5', 'constant.numeric.pin.physical.manta');
    assertScope(tokens, ':', 'punctuation.separator.pin-declaration.manta');
});

test('the membership dot is an accessor (revision 1.6)', async () => {
    const tokens = await tokenize('block b {\n    X = A.{D1~d}.K = Y;\n    .{R1~r}. = GND;\n};');
    assertScope(tokens, '.', 'punctuation.accessor.manta');
});

test('each connector is its own operator', async () => {
    const tokens = await tokenize('block b {\n    A = B == C =* D;\n    E *= F;\n    P ^ Q;\n};');
    assertScope(tokens, '==', 'keyword.operator.continue.manta');
    assertScope(tokens, '=*', 'keyword.operator.gather.manta');
    assertScope(tokens, '*=', 'keyword.operator.broadcast.manta');
    assertScope(tokens, '^', 'keyword.operator.adjacency.manta');
    assertScope(tokens, '=', 'keyword.operator.advance.manta');
});

test('the longer connector wins over the shorter one', async () => {
    // '==' must not tokenize as two '=' advances, which would be a different
    // circuit entirely.
    const tokens = await tokenize('block b {\n    A == B;\n};');
    assert.ok(!tokens.some((t) => t.text === '='), '"==" was split into two "=" tokens');
});

test('multiplicity is an operator with a count', async () => {
    const tokens = await tokenize('block b {\n    A = (.{L?~L1}.)+2 = ({C?~C1}.)*4 = B;\n};');
    assertScope(tokens, '+', 'keyword.operator.multiplicity.manta');
    assertScope(tokens, '*', 'keyword.operator.multiplicity.manta');
    assertScope(tokens, '2', 'constant.numeric.count.manta');
    assertScope(tokens, '4', 'constant.numeric.count.manta');
});

test('port arrows carry their direction and reach', async () => {
    const tokens = await tokenize('block b {\n    3V3>>;\n    SDA<>;\n    >IN;\n};');
    assertScope(tokens, '>>', 'keyword.operator.port.global.manta');
    assertScope(tokens, '<>', 'keyword.operator.port.bidirectional.manta');
    assertScope(tokens, '>', 'keyword.operator.port.manta');
});

test('extern is a keyword', async () => {
    const tokens = await tokenize('block b {\n    extern U9.1 = GND;\n};');
    assertScope(tokens, 'extern', 'keyword.control.extern.manta');
});

// ---------------------------------------------------------------------------
// Comments, strings and substitutions
// ---------------------------------------------------------------------------

test('both comment forms are comments', async () => {
    const tokens = await tokenize('// a line comment\n/* a block\n   comment */\npart p {\n};');
    assertScopeContaining(tokens, 'a line comment', 'comment.line.double-slash.manta');
    assertScopeContaining(tokens, 'a block', 'comment.block.manta');
    assertScope(tokens, 'part', 'keyword.declaration.manta');
});

test('a block comment does not nest', async () => {
    // Spec 2.5: the first '*/' closes it, so what follows is code again.
    const tokens = await tokenize('/* outer /* inner */ part p {\n};');
    assertScope(tokens, 'part', 'keyword.declaration.manta');
});

test('code inside a comment is not code', async () => {
    const tokens = await tokenize('// part fake { };\npart real {\n};');
    for (const token of tokens.filter((t) => t.line === 0)) {
        assert.ok(
            token.scopes.some((s) => s.startsWith('comment.')),
            `a commented-out declaration was highlighted as code: ${token.text}`,
        );
    }
    assertScope(tokens, 'real', 'entity.name.type.manta');
});

test('a string is a string, and its escapes are marked', async () => {
    const tokens = await tokenize('part p {\n    #note = "a \\"quoted\\" word\\nand a line";\n};');
    assertScope(tokens, '\\"', 'constant.character.escape.manta');
    assertScope(tokens, '\\n', 'constant.character.escape.manta');
});

test('an escape manta does not define is flagged', async () => {
    // Spec 3.5 allows exactly \" \\ \n \t.
    const tokens = await tokenize('part p {\n    #note = "bad \\q escape";\n};');
    assertScope(tokens, '\\q', 'invalid.illegal.unknown-escape.manta');
});

test('braces inside a string do not end the declaration', async () => {
    const tokens = await tokenize('part p {\n    #note = "} not the end";\n    @~footprint = F;\n};');
    assertScope(tokens, 'footprint', 'variable.other.field.manta');
});

test('a substitution reads as arithmetic, not as manta', async () => {
    // Spec 14: inside '$...$' a '-' is subtraction and a '/' is division, not
    // the start of a comment.
    const tokens = await tokenize('block b {\n    X = .{R1~R-$"r"*2-1$k-0603}. = Y;\n};');
    assertScope(tokens, '$', /punctuation\.definition\.substitution\.(begin|end)\.manta/);
    assertScope(tokens, '*', 'keyword.operator.arithmetic.manta');
    assertScope(tokens, '-', 'keyword.operator.arithmetic.manta');
});

// ---------------------------------------------------------------------------
// Render section markers (revision 1.3)
// ---------------------------------------------------------------------------

test('a section marker reads as a heading, indentation and all', async () => {
    const tokens = await tokenize('block b {\n    --- USB-C POWER IN\n    A == B;\n};');
    assertScope(tokens, '---', 'punctuation.definition.heading.manta');
    assertScope(tokens, 'USB-C POWER IN', 'markup.heading.manta');
    assertScope(tokens, 'USB-C POWER IN', 'entity.name.section.manta');
    // The code after the marker is still code.
    assertScope(tokens, '==', 'keyword.operator.continue.manta');
});

test("'//' in a section title is title, not a comment", async () => {
    // Spec 4.7: the title is free text to the end of the line.
    const tokens = await tokenize('block b {\n    --- I/O // left side\n};');
    assertScope(tokens, 'I/O // left side', 'markup.heading.manta');
    assert.ok(
        !tokens.some((t) => t.line === 1 && t.scopes.some((s) => s.startsWith('comment.'))),
        'part of a section title was highlighted as a comment',
    );
});

test('a section marker does not usurp the end-of-content marker', async () => {
    const tokens = await tokenize(
        ['block b {', '    --- A SECTION', '};', '---', '--- looks like a section', 'prose'].join('\n'),
    );

    assertScope(tokens, 'A SECTION', 'entity.name.section.manta');
    assertScope(tokens, '---', 'keyword.control.end-of-content.manta');

    // The titled '---' in the tail is documentation like everything else there,
    // not a heading.
    const tail = tokens.filter((t) => t.line > 3);
    assert.ok(tail.length > 0, 'the documentation produced no tokens at all');
    for (const token of tail) {
        assert.ok(
            token.scopes.includes('comment.block.documentation.manta'),
            `line ${token.line}: ${JSON.stringify(token.text)} escaped the documentation scope`,
        );
        assert.ok(
            !token.scopes.some((s) => s.startsWith('markup.heading')),
            `line ${token.line}: ${JSON.stringify(token.text)} was highlighted as a heading`,
        );
    }
});

test("a '---' that is not first on its line is not a heading", async () => {
    const tokens = await tokenize('part p {\n    #note = --- ;\n};');
    assert.ok(
        !tokens.some((t) => t.scopes.some((s) => s.startsWith('markup.heading'))),
        "a '---' mid-line was highlighted as a section heading",
    );
});

// ---------------------------------------------------------------------------
// The end-of-content marker
// ---------------------------------------------------------------------------

test('text after the marker is documentation, not code', async () => {
    const tokens = await tokenize(
        ['part p {', '};', '---', '', 'part not-real { };', '&&& @@@ ###'].join('\n'),
    );

    assertScope(tokens, '---', 'keyword.control.end-of-content.manta');

    const after = tokens.filter((t) => t.line > 2);
    assert.ok(after.length > 0, 'the documentation produced no tokens at all');
    for (const token of after) {
        assert.ok(
            token.scopes.includes('comment.block.documentation.manta'),
            `line ${token.line}: ${JSON.stringify(token.text)} escaped the documentation scope`,
        );
        assert.ok(
            !token.scopes.some((s) => s.startsWith('keyword') || s.startsWith('invalid')),
            `line ${token.line}: ${JSON.stringify(token.text)} was highlighted as code`,
        );
    }
});

test('the marker only ends content at the start of a line, alone', async () => {
    // Spec 2.8. A '---' with anything else on the line is not the marker, and
    // truncating a file on one would be a silent, destructive misreading.
    const tokens = await tokenize('part p {\n    #note = --- ;\n    @~footprint = F;\n};');
    assert.ok(!tokens.some((t) => t.scopes.includes('comment.block.documentation.manta')));
    assertScope(tokens, 'footprint', 'variable.other.field.manta');
});

test('the whole sample file behaves: code before the marker, prose after', async () => {
    const text = readFileSync(join(FIXTURES, 'parts.manta'), 'utf8');
    const tokens = await tokenize(text);

    const marker = tokens.find((t) => t.text === '---');
    assert.ok(marker, 'the fixture lost its end-of-content marker');

    assertScope(tokens, 'MCU-48', 'entity.name.type.manta');
    assertScope(tokens, 'i2c-bus', 'entity.name.type.manta');

    // "block not-a-block {" lives in the datasheet.
    const fakeBlock = tokens.filter((t) => t.text.includes('not-a-block'));
    assert.ok(fakeBlock.length > 0);
    for (const token of fakeBlock) {
        assert.ok(token.scopes.includes('comment.block.documentation.manta'));
    }
});

// ---------------------------------------------------------------------------
// The rules grammar
// ---------------------------------------------------------------------------

test('a cable declaration is highlighted like any other', async () => {
    const tokens = await tokenize(
        'cable jumper-8way {\n    {J1~PLUG}P[1:8] = [[ .{W%[1:8]~WIRE}. ]] = P[1:8]{J2~PLUG};\n};',
    );
    assertScope(tokens, 'cable', 'keyword.declaration.manta');
    assertScope(tokens, 'jumper-8way', 'entity.name.type.manta');
    assertScope(tokens, 'WIRE', 'entity.name.type.instantiated.manta');
});

test('the whole sample file still has no unscoped token after 1.2', async () => {
    const tokens = await tokenize(readFileSync(join(FIXTURES, 'parts.manta'), 'utf8'));
    assertScope(tokens, 'cable', 'keyword.declaration.manta');
    assertScope(tokens, 'jumper-8way', 'entity.name.type.manta');
    assertScope(tokens, '1mm2', 'constant.numeric.dimensioned.manta');
});

test('a rules file highlights its own keywords', async () => {
    const text = readFileSync(join(FIXTURES, 'checks.mantaRules'), 'utf8');
    const tokens = await tokenize(text, 'source.mantarules');

    assertScope(tokens, 'rules', /^keyword\./);
    assertScope(tokens, 'check', /^keyword\./);
    assertScope(tokens, 'when', /^keyword\./);
    assertScope(tokens, 'require', /^keyword\./);
    assertScope(tokens, 'error', /^keyword\./);
    assertScope(tokens, 'warning', /^keyword\./);
    assertScope(tokens, 'for', /^keyword\./);
});

test('a rules file names its check, its domain and its aggregates', async () => {
    const text = readFileSync(join(FIXTURES, 'checks.mantaRules'), 'utf8');
    const tokens = await tokenize(text, 'source.mantarules');

    assertScope(tokens, 'drive-high', 'entity.name.function.check.mantarules');
    assertScope(tokens, 'net', /^(support\.type|entity\.name)\./);
    assertScope(tokens, 'sum', 'support.function.aggregate.mantarules');
    assertScope(tokens, 'any', 'support.function.aggregate.mantarules');
    assertScope(tokens, 'has', 'support.function.aggregate.mantarules');
});

test('a type assertion marks the field and its quantity', async () => {
    const tokens = await tokenize(
        'rules r {\n    #VOH : voltage;\n    #DRAW : current;\n};',
        'source.mantarules',
    );
    assertScope(tokens, 'VOH', 'variable.other.field.mantarules');
    assertScope(tokens, 'voltage', 'support.type.quantity.mantarules');
    assertScope(tokens, 'current', 'support.type.quantity.mantarules');
});

test('the rules language knows the area quantity', async () => {
    const tokens = await tokenize(
        'rules r {\n    #csa : area;\n\n    check c for part {\n'
        + '        require part.csa >= 1mm2;\n    };\n};',
        'source.mantarules',
    );
    assertScope(tokens, 'area', 'support.type.quantity.mantarules');
    assertScope(tokens, '1mm2', 'constant.numeric.dimensioned.manta');
});

test('a rules message is a string, and its comments are comments', async () => {
    const tokens = await tokenize(
        'rules r {\n    // a note\n    check c for net {\n        error "boom {net}";\n    };\n};',
        'source.mantarules',
    );
    assertScopeContaining(tokens, 'a note', 'comment.line.double-slash.manta');
    assert.ok(tokens.some((t) => t.scopes.some((s) => s.startsWith('string.quoted'))));
});
