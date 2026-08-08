// The mocha runner that VS Code's extension host loads.
//
// The extension host requires this module and calls run(); everything after
// that happens inside a real editor.

import { glob } from 'glob';
import Mocha from 'mocha';
import { resolve } from 'path';

export function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60_000 });
    const here = __dirname;

    return glob('**/*.test.js', { cwd: here }).then(
        (files) =>
            new Promise<void>((ok, fail) => {
                for (const file of files) mocha.addFile(resolve(here, file));
                try {
                    mocha.run((failures) => {
                        if (failures > 0) fail(new Error(`${failures} test(s) failed`));
                        else ok();
                    });
                } catch (error) {
                    fail(error);
                }
            }),
    );
}
