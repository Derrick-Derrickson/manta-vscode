// SPDX-FileCopyrightText: 2026 Tom
// SPDX-License-Identifier: GPL-3.0-or-later
// The inline-schematic analysis: wires, collapsible devices, net glyphs.

import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeInline, valueFromPartName } from '../server/src/inline';

const none = () => undefined;

test('a part-name value reads out of the usual spellings', () => {
    assert.equal(valueFromPartName('R-10kR-0603'), '10kR');
    assert.equal(valueFromPartName('C-100nF-0603'), '100nF');
    assert.equal(valueFromPartName('L-4u7H'), '4u7H');
    assert.equal(valueFromPartName('D-SS34'), undefined);
    assert.equal(valueFromPartName('MP1584EN-LF-Z'), undefined);
});

test('a passive collapses to its symbol and value', () => {
    const facts = computeInline('block b { X = .{R1~R-10kR-0603}. = Y; };', none);
    assert.equal(facts.devices.length, 1);
    assert.equal(facts.devices[0].kind, 'resistor');
    assert.equal(facts.devices[0].value, '10kR');
    const line = 'block b { X = .{R1~R-10kR-0603}. = Y; };';
    const d = facts.devices[0];
    assert.equal(line.slice(d.hide.start, d.hide.end), '~R-10kR-0603');
});

test('the index value wins over the part-name guess', () => {
    const facts = computeInline('block b { X = .{C3~BOOT-CAP}. = Y; };',
                                (p) => (p === 'BOOT-CAP' ? '100nF' : undefined));
    assert.equal(facts.devices[0].kind, 'capacitor');
    assert.equal(facts.devices[0].value, '100nF');
});

test('diodes and LEDs get their own symbols', () => {
    const facts = computeInline(
        'block b { A = K.{D2~D-SS34: .A=GND;}; B = A.{D4~LED-RED}.K = C; };', none);
    assert.deepEqual(facts.devices.map((d) => d.kind), ['diode', 'led']);
});

test("a '=' join draws under the gap between terminals", () => {
    const src = 'block b { X = .{R1~R-10kR-0603}. = Y; };';
    const facts = computeInline(src, none);
    const under = facts.joins.filter((j) => !j.over);
    assert.equal(under.length, 2);
    // The first join spans from the end of X to the start of the device.
    assert.equal(src.slice(under[0].span.start, under[0].span.end), ' = ');
});

test("a '==' continuation goes up and over the part it hops", () => {
    const src = 'block b { VIN = .{R1~r}. == .{C1~c: . = GND;} == EN; };';
    const facts = computeInline(src, none);
    const over = facts.joins.filter((j) => j.over);
    assert.equal(over.length, 2);
    // The second hop starts at the dead-end cap and lands on EN.
    const hop = src.slice(over[1].span.start, over[1].span.end);
    assert.ok(hop.startsWith('.{C1~c:'), hop);
    assert.ok(hop.endsWith('== '), hop);
});

test('field and directive assignments are not joins', () => {
    const facts = computeInline(
        'part p { @~footprint = F; #value = 10kR; 1: A &CASUAL; };\n' +
        'block b { GND &TYPE=GROUND; X = Y &CURRENT=3A; };', none);
    assert.equal(facts.joins.length, 1); // only "X = Y"
});

test('ground and rail nets carry their glyphs', () => {
    const facts = computeInline(
        'block b { DIRT &TYPE=GROUND; RAILY &RAIL; 3V3 = .{C1~c: . = DIRT;}; X = RAILY; };',
        none);
    const grounds = facts.marks.filter((m) => m.kind === 'ground').length;
    const rails = facts.marks.filter((m) => m.kind === 'rail').length;
    assert.ok(grounds >= 2, `grounds ${grounds}`); // DIRT twice (decl + use)
    assert.ok(rails >= 3, `rails ${rails}`);       // RAILY twice + 3V3
});

test('binding pins join their nets', () => {
    const src = 'block b { {U2~MP1584: .VIN = VPOS; .GND = GND; }; };';
    const facts = computeInline(src, none);
    const under = facts.joins.filter((j) => !j.over);
    assert.equal(under.length, 2);
});

test('terminal dots stand on the wire', () => {
    const src = 'block b { X = .{R1~R-10kR-0603}. = Y; {U2~p: . = GND; }; A = K.{D1~d}; };';
    const facts = computeInline(src, () => undefined);
    // R1's two terminal dots, the casual binding dot, and D1's attachment dot.
    assert.equal(facts.dots.length, 4);
    for (const d of facts.dots) assert.equal(src.slice(d.start, d.end), '.');
});

test('nothing after the end-of-content marker is analysed', () => {
    const facts = computeInline(
        'part p { 1: A &CASUAL; };\n---\nX = .{R9~R-10kR-0603}. = GND datasheet prose\n', none);
    assert.equal(facts.devices.length, 0);
    assert.equal(facts.joins.length, 0);
});
