# Manta for VS Code

Editor support for the [Manta Schematic Definition Language](https://github.com/Derrick-Derrickson/Manta):
syntax highlighting, a parts browser, and hover documentation.

Written against language revision **1.2**.

This extension is independent of the manta compiler. It reads `.manta` files
directly, so it works on a machine that has no toolchain installed, and it never
shells out to `manta`.

## What it does

### Syntax highlighting

Both languages are covered: `.manta` and `.mantaRules`.

The grammar is written against the specification rather than by eye, so it knows
things a generic highlighter would not:

- The two namespaces are distinguished. `@` is the closed system namespace and
  `#` the open user one, and the strength modifier between the sigil and the
  name (`@~footprint`, `#!manufacturer`) is scoped separately from both.
- `4k7R` and `4.7kR` are one quantity each, and `3V3` is a voltage rather than a
  net whose name starts with a number.
- Two spec violations are marked as errors before the compiler ever runs: an
  imperial literal (§3.4 — manta is metric only) and an identifier ending in `-`
  (§2.3).
- Text after the `---` end-of-content marker (§2.8) is documentation, not code,
  and is left alone. A datasheet pasted below the marker does not get coloured
  as though it were a circuit.
- `&` names that the compiler does not define are still scoped as directives,
  not painted red. The compiler is the authority on which names exist; the
  editor should not disagree with it.
- `1mm2` is one quantity, not `1mm` and a stray digit — the unit table is
  longest-first, as the compiler's is. And `5m5` is *not* coloured as a value:
  `m` is the only unit that is also an SI prefix, so the compiler reads it as
  five milli-something with no unit left and rejects it.
- A range inside a value list — `@map = [[1:20],[20:1]]` — reads as a range,
  while the `:` that separates a binding list stays a binding separator.

### Parts browser

A **Manta** container in the activity bar lists every declaration in the
workspace — parts, blocks, cables, harnesses, net classes and match groups —
with its value and pin count beside it. Click one to jump to it. Hovering a row gives the
same card as hovering the name in a file.

Group it by kind, by file, or flat, from the view's toolbar or from
`manta.parts.groupBy`.

The whole workspace is indexed, not just the open editors, so a part declared in
a file nobody has opened is still listed and still explains itself.

### Hover

Hovering a part name — at its declaration, or at any `~` that instantiates it —
gives a card with the fields that decide which part this is (value, type,
manufacturer, MPN, tolerance, ratings), the doc comment above the declaration,
the pin table, where it is declared, and how many times the workspace
instantiates it.

For a connector that includes `@type` and `@mate` — what it is, and what plugs
into it. Both are `@` fields, which the summary would otherwise skip.

Go-to-definition, document symbols and workspace symbols work from the same
index.

## Requirements

VS Code 1.85 or newer. No other dependencies, and no manta toolchain.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `manta.index.exclude` | `node_modules`, `build`, `.git` | Globs skipped when indexing. |
| `manta.parts.groupBy` | `kind` | How the Parts view arranges declarations: `kind`, `file` or `flat`. |
| `manta.trace.server` | `off` | Trace the client/server conversation, for reporting a bug. |

## How it is put together

```
client/src/     the VS Code side: starts the server, owns the tree view
server/src/     everything that understands manta
syntaxes/       the two TextMate grammars
tests/          unit, grammar and language-server tests
tests/integration/  the suite that runs inside a real VS Code
```

Almost nothing lives in the client. The lexer, the scanner, the index and the
hover renderer are all in a language server with no VS Code imports at all, so
the same understanding of manta can serve any editor that speaks the protocol.
The tree view is the one exception, because a tree view is a VS Code idea with
no equivalent in the protocol — and even that gets its contents from the server
over a custom `manta/parts` request, so the tree and a hover can never disagree
about what a part is.

The server has no filesystem access of its own. The client finds the `.manta`
files and hands their text over, which is what makes indexing unopened files
work.

### Why a scanner and not the compiler

The extension has its own tokenizer and declaration scanner rather than shelling
out to `manta`. That means highlighting and hovers work while you type, on a
file that does not yet parse, and on a machine with no toolchain. The cost is
that the scanner is deliberately shallow: it reads declarations, fields and pin
maps, and it does not elaborate a netlist. Anything requiring elaboration is the
compiler's job, and this extension does not attempt it.

## Building

```sh
npm install
npm run compile
npm test              # 90 tests, no editor required
npm run test:integration   # 19 more, inside a real VS Code
npm run package       # produces manta-vscode.vsix
```

Install the result with `code --install-extension manta-vscode.vsix`, or from
the Extensions view's **Install from VSIX…** menu.

### Testing the highlighting

The grammar tests are not regex assertions about the grammar file. They load the
shipped `.tmLanguage.json` into `vscode-textmate` over `vscode-oniguruma` — the
same engine VS Code itself uses — tokenize manta samples and assert the scope
each piece ends up in. A theme colours by scope, so a grammar that passes these
is coloured correctly in the editor.

A third suite spawns the compiled language server as a real child process and
talks LSP to it over stdio. That is what catches the wiring — a capability never
advertised, a handler under the wrong name, a request whose parameters do not
survive the round trip — none of which a unit test can see.

### Testing inside a real editor

`npm run test:integration` launches VS Code itself, opens a workspace of `.manta`
files and drives the extension through the public API: activation, the Parts
tree, hovers and definitions through the editor's own provider pipeline, and an
edit that has to reach the index. It reuses a system VS Code if one is
installed and downloads a build otherwise, and runs headless under `xvfb-run` on
a machine with no display.

That leaves only how a particular colour theme paints these scopes, which is a
matter of taste rather than correctness.

## Licence

Evaluation licence — see [LICENSE](LICENSE). Not open source; the author intends
to move to GPL-3.0 later.
