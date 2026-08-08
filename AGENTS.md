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
| `tests/` | Unit tests, and grammar tests driving the real TextMate engine. |

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
npm test    # compiles, then runs everything
```

Grammar changes must come with grammar tests. They load the shipped
`.tmLanguage.json` into `vscode-textmate` over `vscode-oniguruma` — VS Code's
own engine — and assert scopes over manta samples. A change that "looks right"
without one is not verified.

What no test here can cover: the tree view's appearance, hover placement, and
theme rendering. Those need a running VS Code, and should be called out as
unverified rather than claimed.

## Adding a language feature

1. Extend `server/src/lexer.ts` if it changes tokenization, and only then.
2. Extend `server/src/scanner.ts` to record it, with a test in
   `tests/scanner.test.ts`.
3. Extend `syntaxes/manta.tmLanguage.json`, with a test in
   `tests/grammar.test.ts`.
4. If it should show in a hover, extend `server/src/describe.ts`.
5. If it should show in the tree, it is already there — the tree renders whatever
   `manta/parts` returns.
