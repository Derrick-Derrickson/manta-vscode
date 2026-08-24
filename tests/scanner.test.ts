// SPDX-FileCopyrightText: 2026 Tom
// SPDX-License-Identifier: GPL-3.0-or-later
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
    // Revision 1.2.
    assert.ok(names.includes('cable:jumper-8way'));
});

test('a cable is a declaration kind of its own', () => {
    const cable = byName(scan(source).declarations, 'jumper-8way');
    assert.equal(cable.kind, 'cable');
    // Its body is a chain, so it declares no pins -- the parts inside it do.
    assert.equal(cable.pins.length, 0);
    assert.equal(cable.fields.find((f) => f.name === 'length')!.value, '300mm');
});

test('the mating fields are read, including a range map', () => {
    const plug = byName(scan(source).declarations, 'JST-8-PLUG');
    const field = (name: string) => plug.fields.find((f) => f.name === name);

    assert.equal(field('type')!.value, 'cableconnector');
    assert.equal(field('type')!.namespace, '@');
    assert.equal(field('mates')!.value, '[BACKPLANE-OUT, BACKPLANE-IN]');
    // A descending range is how a reversed ribbon is written; the order of the
    // endpoints is part of what it means, so it must survive verbatim.
    assert.equal(field('map')!.value, '[[1:8],[8:1]]');

    const board = byName(scan(source).declarations, 'BACKPLANE-OUT');
    assert.equal(board.fields.find((f) => f.name === 'mate')!.value, 'jumper-8way');
    assert.equal(board.fields.find((f) => f.name === 'mate')!.strength, '~');
});

test('a cable instantiates wires and connectors like any chain', () => {
    const names = scan(source).instantiations.map((i) => i.name);
    assert.ok(names.includes('JST-8-PLUG'));
    assert.ok(names.includes('WIRE-22AWG-RED'));
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
// part commented-out { 1: A &CASUAL; };
/* part also-commented { }; */
part real { @~footprint = F; 1: A &CASUAL; };
`);
    assert.deepEqual(declarations.map((d) => d.name), ['real']);
});

test('a declaration inside a string is not a declaration', () => {
    const { declarations } = scan(`
part real {
    @~footprint = F;
    #note = "part fake { } and a } brace";
    1: A &CASUAL;
};
`);
    assert.deepEqual(declarations.map((d) => d.name), ['real']);
    assert.equal(declarations[0].pins.length, 1);
});

test('a pre-1.6 pin line with = still indexes', () => {
    // Revision 1.6 maps a pin with ':'; the scanner keeps reading the old
    // spelling so unmigrated libraries still populate the parts view.
    const { declarations } = scan('part legacy { @~footprint = F; 1 = A &CASUAL; };');
    assert.equal(declarations[0].pins.length, 1);
    assert.equal(declarations[0].pins[0].logical, 'A');
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
// Render sections (revision 1.3)
// ---------------------------------------------------------------------------

test('markers between statements do not confuse the scan', () => {
    const { declarations, instantiations } = scan(`
block charger {
    --- POWER IN
    {J1~CONN-USB-C: VBUS = VBUS;};

    --- REGULATION
    VBUS = VIN{U1~LDO-3V3}VOUT = 3V3;
};

part after { @~footprint = F; 1: A &CASUAL; };
`);
    assert.deepEqual(declarations.map((d) => `${d.kind}:${d.name}`),
                     ['block:charger', 'part:after']);
    assert.deepEqual(instantiations.map((i) => i.name), ['CONN-USB-C', 'LDO-3V3']);
    assert.deepEqual(byName(declarations, 'charger').sections.map((s) => s.title),
                     ['POWER IN', 'REGULATION']);
});

test("a title runs to the end of the line, and '//' is not a comment in it", () => {
    const top = byName(scan(source).declarations, 'top');
    assert.deepEqual(top.sections.map((s) => s.title), [
        'POWER TREE',
        'ANALOG I/O // not a comment: a render section title runs to end of line',
    ]);
});

test('a nested block keeps its markers to itself', () => {
    const { declarations } = scan(`
block outer {
    --- OUTER ONLY
    A == B;
    block inner {
        --- INNER ONLY
        C == D;
    };
};
`);
    const outer = byName(declarations, 'outer');
    assert.deepEqual(outer.sections.map((s) => s.title), ['OUTER ONLY']);
    assert.deepEqual(byName(declarations, 'inner').sections.map((s) => s.title), ['INNER ONLY']);
});

test('a marker in a part body is stepped over, not recorded', () => {
    // Spec 4.7: only a block body may carry a marker; anywhere else it is the
    // compiler's error to report. The index must neither trip on it nor
    // pretend the part has sections.
    const { declarations } = scan(`
part misplaced {
    @~footprint = F;
    --- NOT LEGAL HERE
    1: A &CASUAL;
    2 = B &CASUAL;
};
`);
    const part = byName(declarations, 'misplaced');
    assert.deepEqual(part.sections, []);
    assert.equal(part.pins.length, 2, 'a marker between pin lines broke the pin scan');
});

test('a bare marker inside a block does not end the content', () => {
    // A bare '---' at the top level ends the file (spec 2.8); inside a block it
    // is an error with no title, and either way the declarations around it must
    // survive the scan.
    const { declarations } = scan(`
block broken {
    ---
    A == B;
};
part survivor { @~footprint = F; 1: A &CASUAL; };
`);
    const names = declarations.map((d) => d.name);
    assert.deepEqual(names, ['broken', 'survivor']);
    assert.deepEqual(byName(declarations, 'broken').sections, []);
});

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

test('resolves a name across files', () => {
    const store = new IndexStore();
    store.update('file:///lib.manta', 'part shared { @~footprint = F; 1: A &CASUAL; };');
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
    store.update('file:///lib.manta', 'static part hidden { @~footprint = F; 1: A &CASUAL; };');

    assert.equal(store.lookup('hidden', 'file:///other.manta'), undefined);
    assert.ok(store.lookup('hidden', 'file:///lib.manta'));
});

test('a local static declaration wins over an external one of the same name', () => {
    const store = new IndexStore();
    store.update('file:///a.manta', 'static part dual { @~footprint = LOCAL; 1: A &CASUAL; };');
    store.update('file:///b.manta', 'part dual { @~footprint = EXTERNAL; 1: A &CASUAL; };');

    const fromA = store.lookup('dual', 'file:///a.manta')!;
    assert.equal(fromA.declaration.fields.find((f) => f.name === 'footprint')!.value, 'LOCAL');

    const fromElsewhere = store.lookup('dual', 'file:///c.manta')!;
    assert.equal(
        fromElsewhere.declaration.fields.find((f) => f.name === 'footprint')!.value,
        'EXTERNAL',
    );
});

test('listing is stable regardless of the order files arrive', () => {
    const a = 'part zebra { @~footprint = F; 1: A &CASUAL; };';
    const b = 'part alpha { @~footprint = F; 1: A &CASUAL; };';

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
    const text = 'part p { @~footprint = F; 1: A &CASUAL; };';
    assert.equal(store.update('file:///p.manta', text), true, 'first index is a change');
    assert.equal(store.update('file:///p.manta', text + '\n// a new comment'), false);
    assert.equal(store.update('file:///p.manta', text.replace('p {', 'q {')), true);
});

test('duplicate external names are found; static ones are not duplicates', () => {
    const store = new IndexStore();
    store.update('file:///a.manta', 'part dup { @~footprint = F; 1: A &CASUAL; };');
    store.update('file:///b.manta', 'part dup { @~footprint = G; 1: A &CASUAL; };');
    store.update('file:///c.manta', 'static part priv { @~footprint = F; 1: A &CASUAL; };');
    store.update('file:///d.manta', 'static part priv { @~footprint = G; 1: A &CASUAL; };');

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
