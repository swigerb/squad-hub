#!/usr/bin/env node
'use strict';
require('../src/cli')
  .main(process.argv.slice(2))
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    process.stderr.write(`squad-hub: ${e.message}\n`);
    process.exit(1);
  });
