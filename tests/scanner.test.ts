// The scanner and the index, which are what the parts browser and the hover
// are built on.
//
// No VS Code here: everything under test is deliberately free of editor
// imports, so it runs under plain `node --test`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { describe as describeDecl, summarise } from '../server/src/describe';
import { IndexStore } from '../server/src/index-store';
import { Declaration, flatten, scan } from '../server/src/scanner';
import { wordAt } from '../server/src/word';

const FIXTURES = join(__dirname, '..', '..', 'tests', 'fixtures');
const source = readFileSync(join(FIXTURES, 'parts.manta'), 'utf8');

function byName(decls: Declaration[], name: string): Declaration {
    const found = flatten(decls).find((d) => d.name === name);
    assert.ok(found, `no declaration named ${name}`);
    return found;
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

test('finds every kind of declaration', () => {
    const { declarations } = scan(source);
    const names = flatten(declarations).map((d) => `${d.kind}:${d.name}`);

    assert.ok(names.includes('part:MCU-48'));
    assert.ok(names.includes('part:R-10k-1pct-0603'));
    assert.ok(names.includes('harness:i2c-bus'));
    assert.ok(names.includes('netclass:power'));
    assert.ok(names.includes('match:ddr-addr'));
    assert.ok(names.includes('block:rc-filter'));
    assert.ok(names.includes('block:top'));
});

test('records internal linkage', () => {
    const { declarations } = scan(source);
    assert.equal(byName(declarations, 'R-10k-1pct-0603').isStatic, true);
    assert.equal(byName(declarations, 'MCU-48').isStatic, false);
});

test('a leading comment block becomes the description', () => {
    const mcu = byName(scan(source).declarations, 'MCU-48');
    assert.match(mcu.doc, /^A microcontroller\./);
    assert.match(mcu.doc, /open-drain/);
    // The '//' markers are stripped, not carried through.
    assert.ok(!mcu.doc.includes('//'));
});

test('a declaration name is not confused by a hyphen', () => {
    // "R-10k-1pct-0603" is one identifier, not four.
    const decl = byName(scan(source).declarations, 'R-10k-1pct-0603');
    assert.equal(decl.name, 'R-10k-1pct-0603');
});

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

test('reads fields with their namespace, strength and direction', () => {
    const mcu = byName(scan(source).declarations, 'MCU-48');
    const field = (name: string) => mcu.fields.find((f) => f.name === name);

    assert.deepEqual(
        { ...field('footprint')! , range: undefined },
        { namespace: '@', strength: '~', name: 'footprint', value: 'LQFP-48',
          direction: 'local', range: undefined },
    );
    assert.equal(field('manufacturer')!.strength, '!');
    assert.equal(field('manufacturer')!.value, '"ST Microelectronics"');
    assert.equal(field('source')!.direction, 'import');
    assert.equal(field('source')!.strength, '~');
    assert.equal(field('VERSION')!.value, '1.1+');
});

test('a tolerance keeps its sign', () => {
    const resistor = byName(scan(source).declarations, 'R-10k-1pct-0603');
    assert.equal(resistor.fields.find((f) => f.name === 'tolerance')!.value, '±1%');
});

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

test('counts the pins a range declares', () => {
    const mcu = byName(scan(source).declarations, 'MCU-48');
    const bus = mcu.pins.find((p) => p.physical === '[1:48]');
    assert.ok(bus);
    assert.equal(bus.count, 48, 'a 48-pin range declares 48 pins');
    assert.equal(bus.logical, 'IO[1:48]');
    assert.equal(bus.arrow, '<>');

    const total = mcu.pins.reduce((n, p) => n + p.count, 0);
    assert.equal(total, 52, '48 in the bus, plus four singles');
});

test('separates directives from pin fields', () => {
    const mcu = byName(scan(source).declarations, 'MCU-48');
    const bus = mcu.pins.find((p) => p.physical === '[1:48]')!;

    assert.deepEqual(bus.fields, ['#VOH=2V4', '#VOL=0V4', '#VIH=2V0', '#VIL=0V8']);
    assert.deepEqual(bus.directives, ['&SWAP=bank0']);

    const vcc = mcu.pins.find((p) => p.logical === 'VCC')!;
    assert.deepEqual(vcc.directives, ['&TYPE=POWER', '&~NET=3V3']);
    assert.deepEqual(vcc.fields, ['#DRAW=25mA']);
    assert.equal(vcc.arrow, '<');
});

test('only a part has pins', () => {
    const { declarations } = scan(source);
    assert.equal(byName(declarations, 'i2c-bus').pins.length, 0);
    assert.equal(byName(declarations, 'top').pins.length, 0);
});

// ---------------------------------------------------------------------------
// The things that defeat a regex
// ---------------------------------------------------------------------------

test('text after the end-of-content marker is not scanned', () => {
    // The fixture's datasheet contains "block not-a-block {", which a naive
    // scan would report as a declaration.
    const names = flatten(scan(source).declarations).map((d) => d.name);
    assert.ok(!names.includes('not-a-block'), 'documentation was scanned as code');
});

test('a declaration inside a comment is not a declaration', () => {
    const { declarations } = scan(`
// part commented-out { 1 = A &CASUAL; };
/* part also-commented { }; */
part real { @~footprint = F; 1 = A &CASUAL; };
`);
    assert.deepEqual(declarations.map((d) => d.name), ['real']);
});

test('a declaration inside a string is not a declaration', () => {
    const { declarations } = scan(`
part real {
    @~footprint = F;
    #note = "part fake { } and a } brace";
    1 = A &CASUAL;
};
`);
    assert.deepEqual(declarations.map((d) => d.name), ['real']);
    assert.equal(declarations[0].pins.length, 1);
});

test('nested declarations are found and kept nested', () => {
    const { declarations } = scan(`
match outer {
    @src = U1;
    match inner {
        @src = U2;
    };
};
`);
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].name, 'outer');
    assert.deepEqual(declarations[0].children.map((c) => c.name), ['inner']);
    assert.equal(flatten(declarations).length, 2);
});

test('instantiations are counted, including inside bodies', () => {
    const { instantiations } = scan(source);
    const names = instantiations.map((i) => i.name);
    assert.ok(names.includes('MT100UFA'));
    assert.ok(names.includes('AMP012'));
    assert.ok(names.includes('conn-4'));
    assert.equal(names.filter((n) => n === 'conn-4').length, 2);
});

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

test('resolves a name across files', () => {
    const store = new IndexStore();
    store.update('file:///lib.manta', 'part shared { @~footprint = F; 1 = A &CASUAL; };');
    store.update('file:///board.manta', 'block b { X = .{R1~shared}. = GND; };');

    const found = store.lookup('shared', 'file:///board.manta');
    assert.ok(found);
    assert.equal(found.uri, 'file:///lib.manta');
    assert.equal(store.instantiations('shared'), 1);
});

test('a static declaration is invisible from another file', () => {
    // Internal linkage, exactly as the compiler treats it: the failure this
    // models is real, and reporting the wrong declaration would be worse than
    // reporting none.
    const store = new IndexStore();
    store.update('file:///lib.manta', 'static part hidden { @~footprint = F; 1 = A &CASUAL; };');

    assert.equal(store.lookup('hidden', 'file:///other.manta'), undefined);
    assert.ok(store.lookup('hidden', 'file:///lib.manta'));
});

test('a local static declaration wins over an external one of the same name', () => {
    const store = new IndexStore();
    store.update('file:///a.manta', 'static part dual { @~footprint = LOCAL; 1 = A &CASUAL; };');
    store.update('file:///b.manta', 'part dual { @~footprint = EXTERNAL; 1 = A &CASUAL; };');

    const fromA = store.lookup('dual', 'file:///a.manta')!;
    assert.equal(fromA.declaration.fields.find((f) => f.name === 'footprint')!.value, 'LOCAL');

    const fromElsewhere = store.lookup('dual', 'file:///c.manta')!;
    assert.equal(
        fromElsewhere.declaration.fields.find((f) => f.name === 'footprint')!.value,
        'EXTERNAL',
    );
});

test('listing is stable regardless of the order files arrive', () => {
    const a = 'part zebra { @~footprint = F; 1 = A &CASUAL; };';
    const b = 'part alpha { @~footprint = F; 1 = A &CASUAL; };';

    const first = new IndexStore();
    first.update('file:///1.manta', a);
    first.update('file:///2.manta', b);

    const second = new IndexStore();
    second.update('file:///2.manta', b);
    second.update('file:///1.manta', a);

    assert.deepEqual(
        first.all().map((x) => x.declaration.name),
        second.all().map((x) => x.declaration.name),
    );
});

test('an edit that changes nothing visible does not report a change', () => {
    const store = new IndexStore();
    const text = 'part p { @~footprint = F; 1 = A &CASUAL; };';
    assert.equal(store.update('file:///p.manta', text), true, 'first index is a change');
    assert.equal(store.update('file:///p.manta', text + '\n// a new comment'), false);
    assert.equal(store.update('file:///p.manta', text.replace('p {', 'q {')), true);
});

test('duplicate external names are found; static ones are not duplicates', () => {
    const store = new IndexStore();
    store.update('file:///a.manta', 'part dup { @~footprint = F; 1 = A &CASUAL; };');
    store.update('file:///b.manta', 'part dup { @~footprint = G; 1 = A &CASUAL; };');
    store.update('file:///c.manta', 'static part priv { @~footprint = F; 1 = A &CASUAL; };');
    store.update('file:///d.manta', 'static part priv { @~footprint = G; 1 = A &CASUAL; };');

    const duplicates = store.duplicates();
    assert.deepEqual([...duplicates.keys()], ['dup']);
});

// ---------------------------------------------------------------------------
// Hover text
// ---------------------------------------------------------------------------

test('a hover card carries the facts that decide which part this is', () => {
    const mcu = byName(scan(source).declarations, 'MCU-48');
    const card = describeDecl(mcu, { instantiations: 3, location: 'parts.manta' });

    // The name is Markdown-escaped, since a hover renders as Markdown.
    assert.match(card, /\*\*MCU\\?-48\*\*/);
    assert.match(card, /footprint `LQFP-48`/);
    assert.match(card, /value `STM32F0QA5`/);
    // A quoted string reads as prose, without its quotes.
    assert.match(card, /manufacturer `ST Microelectronics`/);
    assert.match(card, /52 pins/);
    assert.match(card, /A microcontroller\./);
    assert.match(card, /3 instantiations/);
    assert.match(card, /parts\.manta/);
});

test('a hover card says plainly when nothing instantiates a part', () => {
    const mcu = byName(scan(source).declarations, 'MCU-48');
    assert.match(describeDecl(mcu, { instantiations: 0 }), /not instantiated in this workspace/);
});

test('a long pin list is truncated rather than filling the screen', () => {
    const mcu = byName(scan(source).declarations, 'MCU-48');
    const card = describeDecl(mcu, { maxPins: 2 });
    assert.match(card, /… 3 more line\(s\)/);
});

test('the tree summary is short and useful', () => {
    const { declarations } = scan(source);
    assert.equal(summarise(byName(declarations, 'MCU-48')), 'STM32F0QA5 · 52 pins');
    assert.equal(summarise(byName(declarations, 'R-10k-1pct-0603')), '10kR · 2 pins');
});

// ---------------------------------------------------------------------------
// Finding the word under the cursor
// ---------------------------------------------------------------------------

test('a hyphenated identifier is one word', () => {
    const text = 'X = .{R1~R-10k-1pct-0603}. = Y;';
    const at = text.indexOf('1pct');
    assert.equal(wordAt(text, at)!.text, 'R-10k-1pct-0603');
});

test('a dotted reference is two words, not one', () => {
    const text = 'TP1 = U1.GPIO9 &STUB;';
    assert.equal(wordAt(text, text.indexOf('U1'))!.text, 'U1');
    assert.equal(wordAt(text, text.indexOf('GPIO9'))!.text, 'GPIO9');
});

test('a net whose name begins with a hyphen is one word', () => {
    const text = 'BIAS == -5V;';
    assert.equal(wordAt(text, text.indexOf('5V'))!.text, '-5V');
});

test('the cursor just past a word still means that word', () => {
    const text = 'part MCU-48 {';
    assert.equal(wordAt(text, text.indexOf(' {'))!.text, 'MCU-48');
});

test('there is no word in whitespace', () => {
    assert.equal(wordAt('a   b', 2), undefined);
});
