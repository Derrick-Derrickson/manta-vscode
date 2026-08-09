// Turning a declaration into the Markdown a hover shows.
//
// The aim is a card someone can read at a glance without leaving the line they
// are on: what the thing is, what it is made of, and the handful of facts that
// decide whether it is the right one. Everything else is a click away.

import { Declaration, Field, Pin } from './scanner';

const KIND_LABEL: Record<Declaration['kind'], string> = {
    part: 'part',
    block: 'block',
    harness: 'harness',
    netclass: 'net class',
    match: 'match group',
    cable: 'cable',
};

/**
 * Fields worth putting in the summary line, in the order they read best.
 *
 * 'type' and 'mate' are '@' fields rather than '#' ones, but the lookup is by
 * name and not by namespace, so both land here. They earn the place: 'type'
 * decides whether a part is a connector at all, and 'mate' is the whole of what
 * plugs into it.
 */
const SUMMARY_FIELDS = ['value', 'type', 'mate', 'mates', 'manufacturer', 'mpn',
                        'tolerance', 'power', 'voltage', 'csa'];

function field(decl: Declaration, name: string, namespace?: '@' | '#'): Field | undefined {
    return decl.fields.find((f) => f.name === name && (!namespace || f.namespace === namespace));
}

function escape(text: string): string {
    return text.replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1');
}

/** Strips the quotes a string field carries, so a hover reads as prose. */
function plain(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return trimmed;
}

function pinCount(decl: Declaration): number {
    return decl.pins.reduce((total, pin) => total + pin.count, 0);
}

/** "VCC<  &TYPE=POWER &~NET=3V3" as one readable line. */
function pinLine(pin: Pin): string {
    const parts = [pin.logical + pin.arrow];
    if (pin.directives.length) parts.push(pin.directives.join(' '));
    if (pin.fields.length) parts.push(pin.fields.join(' '));
    return parts.join('  ');
}

export interface DescribeOptions {
    /** How many pins to list before summarising the rest. */
    maxPins?: number;
    /** Instantiation count across the workspace, when known. */
    instantiations?: number;
    /** Where it is declared, shown when the hover is not in that file. */
    location?: string;
}

export function describe(decl: Declaration, options: DescribeOptions = {}): string {
    const maxPins = options.maxPins ?? 18;
    const out: string[] = [];

    // --- title -------------------------------------------------------------
    const linkage = decl.isStatic ? 'static ' : '';
    out.push(`**${escape(decl.name)}**  \`${linkage}${KIND_LABEL[decl.kind]}\``);

    // --- summary -----------------------------------------------------------
    const summary: string[] = [];
    for (const name of SUMMARY_FIELDS) {
        const f = field(decl, name, '#');
        if (f) summary.push(`${name} \`${plain(f.value)}\``);
    }
    const footprint = field(decl, 'footprint', '@');
    if (footprint) summary.unshift(`footprint \`${plain(footprint.value)}\``);
    if (summary.length) out.push('', summary.join(' · '));

    // --- the author's own words --------------------------------------------
    if (decl.doc) out.push('', decl.doc);

    // --- pins ---------------------------------------------------------------
    if (decl.kind === 'part' && decl.pins.length) {
        const total = pinCount(decl);
        out.push('', `---`, '', `**${total} pin${total === 1 ? '' : 's'}**`, '');

        const shown = decl.pins.slice(0, maxPins);
        const width = Math.max(...shown.map((p) => p.physical.length));
        const lines = shown.map((p) => `${p.physical.padEnd(width)}  =  ${pinLine(p)}`);
        if (decl.pins.length > maxPins) {
            lines.push(`… ${decl.pins.length - maxPins} more line(s)`);
        }
        out.push('```manta', ...lines, '```');
    }

    // --- ports, for a block --------------------------------------------------
    if (decl.kind === 'block' && decl.children.length) {
        const kinds = decl.children.map((c) => `${c.name} (${KIND_LABEL[c.kind]})`);
        out.push('', `Contains: ${kinds.join(', ')}`);
    }

    // --- the rest of the fields ----------------------------------------------
    const rest = decl.fields.filter(
        (f) =>
            !(f.namespace === '#' && SUMMARY_FIELDS.includes(f.name)) &&
            !(f.namespace === '@' && f.name === 'footprint'),
    );
    if (rest.length) {
        out.push('', '---', '');
        for (const f of rest) {
            const sigil = `${f.namespace}${f.strength}`;
            out.push(`\`${sigil}${f.name}\` = \`${plain(f.value)}\`  `);
        }
    }

    // --- where and how used ---------------------------------------------------
    const footer: string[] = [];
    if (options.instantiations !== undefined) {
        footer.push(
            options.instantiations === 0
                ? 'not instantiated in this workspace'
                : `${options.instantiations} instantiation${options.instantiations === 1 ? '' : 's'}`,
        );
    }
    if (options.location) footer.push(options.location);
    if (footer.length) out.push('', '---', '', `*${footer.join(' · ')}*`);

    return out.join('\n');
}

/** The one-line form the parts tree shows beside a name. */
export function summarise(decl: Declaration): string {
    if (decl.kind === 'part') {
        const value = field(decl, 'value', '#');
        const total = pinCount(decl);
        const bits: string[] = [];
        if (value) bits.push(plain(value.value));
        if (total) bits.push(`${total} pin${total === 1 ? '' : 's'}`);
        return bits.join(' · ');
    }
    if (decl.kind === 'block') {
        const description = field(decl, 'description', '#');
        if (description) return plain(description.value);
    }
    return '';
}
