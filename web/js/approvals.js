// ---------------------------------------------------------------------------
// Approval depth.
//
// An approval card that says only "the agent wants to run a tool" makes every
// decision look the same. Reading a file and rewriting a directory are not the
// same decision, and the card has to say which one is on the table.
// ---------------------------------------------------------------------------

/**
 * What an approval actually touches, as rows.
 *
 * The tool first, then every path it named. Each row carries whether it is
 * read-only, because that is the single fact that most changes the answer.
 * The flag is decided on the device, from the agent's declared tool kind and,
 * for a shell call, from the command itself -- every shell call arrives as one
 * kind, so the kind alone cannot tell `git status` from `rm -rf`.
 */
export function approvalRows(approval) {
  if (!approval) return [];
  const readOnly = !!approval.readOnly;
  const rows = [{
    kind: 'tool',
    label: approval.command || approval.title || 'an unnamed tool',
    readOnly,
  }];
  for (const p of approval.paths || []) {
    rows.push({ kind: 'path', label: String(p), readOnly });
  }
  return rows;
}

/**
 * Is this approval read-only in its entirety?
 *
 * Used to soften the card. A mixed approval is treated as NOT read-only: one
 * writing path in a list of reads is still a write, and the badge has to
 * reflect the riskiest thing in the request rather than the average.
 */
export function approvalIsReadOnly(approval) {
  const rows = approvalRows(approval);
  return rows.length > 0 && rows.every((r) => r.readOnly);
}

