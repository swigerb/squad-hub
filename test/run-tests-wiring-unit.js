'use strict';
/**
 * test/run-tests.js still wires in the escape-focus child suite: registered, and
 * invoked in the sequential run order. Read from the runner's SOURCE, so it
 * holds when this file runs alone and when the harness mutates the runner.
 * Extracted from test/run-tests.js, where a check about the runner's own text
 * could only be reached by running the whole suite.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RUNNER = path.join(__dirname, 'run-tests.js');
const { check, finish } = require('./helpers/device-harness').resultReporter();

check('run-tests.js still wires in the escape-focus child suite and invocation', () => {
  const source = fs.readFileSync(RUNNER, 'utf8').replace(/\r\n/g, '\n');
  // Start every indexOf() at a marker that sits before the suite definitions,
  // so the search lands on the real wiring and not on a comment that merely
  // mentions it.
  const searchFrom = source.indexOf(
    '// ---------------------------------------------------------------------------\n// CRITERION 2');
  assert.ok(searchFrom !== -1, 'could not find a stable marker in run-tests.js to search from');
  const suiteStart = source.indexOf('async function suiteEscapeFocus() {', searchFrom);
  assert.ok(suiteStart !== -1, 'suiteEscapeFocus() is missing');
  const suiteEnd = source.indexOf('/**\n * Approval depth', suiteStart);
  assert.ok(suiteEnd !== -1, 'suiteEscapeFocus() no longer sits before suiteApprovalDepth()');
  const suiteSource = source.slice(suiteStart, suiteEnd);
  assert.ok(suiteSource.includes("runChildSuite(path.join(__dirname, 'escape-focus-unit.js'), 'escape-focus');"),
    'run-tests.js no longer registers test/escape-focus-unit.js');
  const orderStart = source.indexOf('  await suiteModuleLink();', searchFrom);
  assert.ok(orderStart !== -1, 'suiteModuleLink() is missing from the sequential run order');
  const orderEnd = source.indexOf('  await suiteApprovalDepth();', orderStart);
  assert.ok(orderEnd !== -1, 'suiteApprovalDepth() is missing from the sequential run order');
  const orderSource = source.slice(orderStart, orderEnd);
  assert.ok(orderSource.includes('  await suiteEscapeFocus();'),
    'run-tests.js no longer invokes suiteEscapeFocus()');
});

finish();
