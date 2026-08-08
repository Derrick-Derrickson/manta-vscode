// Finding the identifier under the cursor.
//
// Manta identifiers admit '-' inside them, which is what makes a naive word
// lookup wrong here: hovering "R-10k-1pct-0603" must give the whole name, not
// "1pct". A '.' is not part of a name -- "U1.GPIO1" is a designator and a pin,
// and hovering either half should mean that half.

export interface Word {
    text: string;
    start: number;
    end: number;
}

const isBody = (c: string) => /[A-Za-z0-9_\-]/.test(c);

export function wordAt(text: string, offset: number): Word | undefined {
    if (offset > text.length) return undefined;

    // A cursor just past the end of a word still means that word.
    let at = offset;
    if ((at >= text.length || !isBody(text[at])) && at > 0 && isBody(text[at - 1])) at--;
    if (at >= text.length || !isBody(text[at])) return undefined;

    let start = at;
    while (start > 0 && isBody(text[start - 1])) start--;
    let end = at;
    while (end < text.length && isBody(text[end])) end++;

    // Spec 2.3 forbids a trailing '-', so one here belongs to whatever follows.
    while (end > start && text[end - 1] === '-') end--;
    // A leading '-' is part of a net name such as "-5V", but only when the
    // character before it cannot continue a word.
    if (start > 0 && text[start - 1] === '-' && (start < 2 || !isBody(text[start - 2]))) start--;

    if (end <= start) return undefined;
    return { text: text.slice(start, end), start, end };
}
