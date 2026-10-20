// Fails if contracts/generated differs from what is committed (CLAUDE.md §3).
//
// Uses `git status --porcelain`, NOT `git diff --exit-code`: git diff is blind
// to untracked files, so a brand-new generated schema would pass a diff-based
// guard while sitting uncommitted. Status reports added, modified and deleted
// alike.
import { execFileSync } from 'node:child_process';

const out = execFileSync('git', ['status', '--porcelain', '--', 'contracts/generated'], {
  encoding: 'utf8',
});

if (out.trim() === '') {
  process.stdout.write('contracts/generated is in sync\n');
  process.exit(0);
}

process.stderr.write(
  'ERROR: contracts/generated is stale or uncommitted. Commit the regenerated files.\n\n' +
    out +
    '\nRun `make contracts` (or `pnpm run contracts`) and commit the result.\n',
);
process.exit(1);
