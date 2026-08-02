'use strict';
/** The detached daemon process entry point. Not called directly by users. */

const { Daemon } = require('./daemon');

const d = new Daemon();
d.listen().catch((e) => {
  d.log(`daemon failed to start: ${e.message}`);
  process.stderr.write(`squad-hub daemon failed to start: ${e.message}\n`);
  process.exit(1);
});
