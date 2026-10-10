'use strict';
/**
 * `--shard N/K` for test/mutate.js: one sweep split across K isolated checkouts.
 *
 * Selection is a plain ordinal partition. The runnable mutations -- not
 * skipped, and matching `--only` when that is given -- are numbered from zero in
 * catalogue order, and shard N takes every ordinal with `ordinal % K === N - 1`.
 * So the K shards are disjoint, together they are exactly the runnable set, and
 * their sizes differ by at most one. Nothing about a shard depends on how long a
 * mutation takes or on anything but the catalogue, so each checkout computes
 * the same split on its own.
 *
 * A shard is a smaller RUN of the same gate, never a looser one: the baseline,
 * the named-failure check, the restore and the timeouts are all unchanged. A
 * request that selects nothing is an error, because an empty shard reported as
 * green would read as a clean sweep of work that never ran.
 */

const SHARD = /^([1-9]\d*)\/([1-9]\d*)$/;

/** `"N/K"` -> `{ index: N - 1, count: K, label }`. Throws unless 1 <= N <= K. */
function parseShard(text) {
  const m = typeof text === 'string' ? SHARD.exec(text) : null;
  if (!m) throw new Error(`--shard needs N/K, two positive integers such as 2/4, not ${JSON.stringify(text)}`);
  const n = Number(m[1]);
  const k = Number(m[2]);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(k)) throw new Error(`--shard ${text} is too large`);
  if (n > k) throw new Error(`--shard needs N <= K, got ${n}/${k}`);
  return { index: n - 1, count: k, label: `${n}/${k}` };
}

/** The shard asked for on the command line, or null when `--shard` is absent. */
function shardFromArgv(argv) {
  const at = argv.indexOf('--shard');
  if (at === -1) return null;
  if (argv.indexOf('--shard', at + 1) !== -1) throw new Error('--shard was given more than once');
  return parseShard(argv[at + 1]);
}

/**
 * The mutations a run executes, in catalogue order: the runnable ones, narrowed
 * by `only`, then by `shard`. The ordinal is taken AFTER `only`, so the shards
 * of a filtered run are as even as those of a full one.
 */
function selectMutations(mutations, { only = null, shard = null } = {}) {
  const runnable = mutations.filter((m) => !m.skip && (!only || m.name.includes(only)));
  return shard ? runnable.filter((_, i) => i % shard.count === shard.index) : runnable;
}

/** `{ shard, selected, total }` for a command line, or a thrown Error that says why not. */
function planRun(argv, mutations, only) {
  const shard = shardFromArgv(argv);
  const selected = selectMutations(mutations, { only, shard });
  const total = selectMutations(mutations, { only }).length;
  if (shard && !selected.length) {
    throw new Error(`shard ${shard.label} has nothing to run: ${total} runnable mutation(s) cannot fill ${shard.count} shards`);
  }
  return { shard, selected, total };
}

module.exports = { parseShard, shardFromArgv, selectMutations, planRun };
