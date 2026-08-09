// SPDX-FileCopyrightText: 2026 Tom
// SPDX-License-Identifier: GPL-3.0-or-later
// The small amount of URI handling the server needs.
//
// Not a URI library: the server only ever needs a readable file name for a
// hover footer and a tree label, and pulling in a dependency for that would be
// out of proportion.

export const URI = {
    basename(uri: string): string {
        const withoutQuery = uri.split(/[?#]/)[0];
        const last = withoutQuery.split('/').pop() ?? withoutQuery;
        try {
            return decodeURIComponent(last);
        } catch {
            return last;
        }
    },

    /** A path relative to a workspace root, when the file is inside one. */
    relative(uri: string, root: string | undefined): string {
        if (root && uri.startsWith(root)) {
            const rest = uri.slice(root.length).replace(/^\//, '');
            try {
                return decodeURIComponent(rest);
            } catch {
                return rest;
            }
        }
        return URI.basename(uri);
    },
};
