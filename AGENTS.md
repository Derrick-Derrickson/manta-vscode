# Working on this repository

Editor support for the Manta Schematic Definition Language. The language itself
is specified in the [Manta repository](https://github.com/Derrick-Derrickson/Manta)
— `docs/spec.md` for the language, `docs/rules.md` for `.mantaRules`. That
specification is the authority; this extension is only ever a reader of it.

## Layout

| | |
|---|---|
| `client/src/` | The VS Code side: starts the server, owns the tree view. |
| `server/src/` | Everything that understands manta. No VS Code imports. |
| `syntaxes/` | The two TextMate grammars. |
| `tests/` | Unit, grammar and language-server tests. |
| `tests/integration/` | The suite that runs inside a real VS Code. |

## The language moves; this must follow

The extension is written against a revision of the language, and the compiler is
the authority on what that revision contains. `docs/spec.md` in the
[Manta repository](https://github.com/Derrick-Derrickson/Manta) is where a
construct is defined; §19 is the grammar and §2.6 the reserved words.

Currently written against **revision 1.3**: everything 1.2 brought (the `cable`
declaration, `@type` and the mating fields, the area unit `m2`, range values)
plus the render section marker of §4.7 — a line-first `--- TITLE` inside a
block body, which the grammar paints as a heading, the lexer carries as one
whole-line token, and the outline shows as a caption under its block.

Adding a declaration kind here means three places, none of which the type checker
will point at:

- `KINDS` in `server/src/scanner.ts` — otherwise `tryDeclaration` does not
  recognise it and it never reaches the index or the Parts view.
- the `declaration` rule in `syntaxes/manta.tmLanguage.json` — otherwise the
  keyword is not coloured.
- `DeclKind` in both `server/src/scanner.ts` and `client/src/parts-view.ts`,
  plus `KIND_ORDER`, `KIND_PLURAL` and `KIND_ICON` in the latter — the tree
  groups by kind and an unlisted one is dropped from the grouping.

Adding a unit means one: the `values` rule in the grammar. Two traps there, both
already sprung once:

- **Longest first.** `m2` has to be tried before `m`, or `1mm2` colours as `1mm`
  and a stray digit. The compiler's own unit table carries the same comment.
- **The point-substituted form is not for every unit.** `3V3` is 3.3 volts, but
  `5m5` is nothing at all: `m` is the only unit that is also an SI prefix, so
  the compiler eats it as milli and finds no unit left. `m` — and `m2` with it —
  is excluded from that rule deliberately.

## Rules that are not negotiable

**Nothing in `server/` may import `vscode`.** The server is a language server,
not an extension; the boundary is what lets it serve other editors, and it is
also what makes the tests runnable under plain `node --test`.

**The server has no filesystem.** It is given file contents by the client over
`manta/indexFiles`. Do not add `fs` calls to it — indexing unopened files is a
client responsibility and it already works.

**The compiler is the authority on what is legal manta.** The grammar marks
exactly two things `invalid`: an imperial literal and a trailing hyphen, both of
which the specification states flatly. Do not add speculative error highlighting
for anything the compiler might accept — an editor that contradicts the compiler
is worse than one that says nothing.

**Never shell out to `manta`.** The extension must work with no toolchain
installed, and on a file that does not yet parse.

## Where the traps are

These are the cases that have already been got wrong once:

- **The end-of-content marker.** A line of exactly `---` at brace depth zero
  ends the manta content of a file; everything after is a datasheet. Any code
  that walks a file must stop there. The scanner's `TokenKind.EndOfContent` and
  the grammar's `end-of-content` rule both exist for this.
- **`---` is two things.** The same three characters end the content at the top
  level and title a render section inside a block body (§4.7, revision 1.3).
  The lexer tells them apart by brace depth, and lexes a marker line as one
  whole-line `TokenKind.SectionMarker` — the title is free text, so tokenizing
  it normally would read a `//` inside it as a comment. The TextMate grammar
  cannot see brace depth; it settles for "bare `---` at column zero is
  end-of-content, `---` plus a title is a heading", which is right everywhere
  legal manta can put them.
- **The digit-run rule for `.`.** A `.` joins the current word only while a
  number is being built, so `4.7kR` and `0.2-1.2` stay whole but `U1.GPIO1`
  splits at the dot. Both behaviours are load-bearing.
- **Hyphens are identifier characters.** `R-10k-1pct-0603` is one name. A
  *trailing* hyphen is the error. Anything doing word boundaries — `wordAt`, the
  grammar, `wordPattern` in `language-configuration.json` — must agree on this.
- **`~` is overloaded.** It instantiates (`R1~PART`) and it is also the weak
  strength modifier (`@~footprint`, `&~NET`). Telling them apart is what
  `tryInstantiation` does, by requiring a designator before it.
- **`static` means internal linkage.** `IndexStore.lookup` honours it. Resolving
  a name to a static declaration in another file would report a part the
  compiler will not find.
- **Determinism.** `IndexStore.all()` sorts, so the Parts view does not reshuffle
  when files arrive in a different order. Keep it that way.
- **TypeScript narrows across `advance()`.** A getter's narrowed type survives a
  call that moves the position, which turns a correct comparison into a
  "no overlap" error. `Scanner.atComment()` is a method for exactly this reason;
  do not inline it back.

## Testing

```sh
npm test                 # compiles, then runs everything that needs no editor
npm run test:integration # the same extension, inside a real VS Code
npm run test:all         # both
```

The integration suite needs a display. On a headless machine it is already
wrapped in `xvfb-run`, so `apt install xvfb` is the only prerequisite. It reuses
a system VS Code when one is installed and downloads a build otherwise.

Grammar changes must come with grammar tests. They load the shipped
`.tmLanguage.json` into `vscode-textmate` over `vscode-oniguruma` — VS Code's
own engine — and assert scopes over manta samples. A change that "looks right"
without one is not verified.

`activate` returns a `MantaApi` so the integration suite can read what the Parts
view is actually showing rather than a copy of the data that never went through
the tree. It is a test seam, not a public commitment; do not grow it into one.

What no test here can cover: how a particular colour theme paints these scopes.
Call that out as a matter of taste rather than claiming it verified.

## Adding a language feature

1. Extend `server/src/lexer.ts` if it changes tokenization, and only then.
2. Extend `server/src/scanner.ts` to record it, with a test in
   `tests/scanner.test.ts`.
3. Extend `syntaxes/manta.tmLanguage.json`, with a test in
   `tests/grammar.test.ts`.
4. If it should show in a hover, extend `server/src/describe.ts`.
5. If it should show in the tree, it is already there — the tree renders whatever
   `manta/parts` returns.
