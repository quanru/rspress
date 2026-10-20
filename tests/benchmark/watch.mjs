import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const [runId, output, mode] = process.argv.slice(2);
if (!/^\d+$/.test(runId ?? '') || !output) throw new Error('Expected run ID and output directory');
const repo = 'quanru/rspress';
await mkdir(output, { recursive: true });
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 120_000 });
}
function jsonReport(text) {
  const start = text.search(/\{\s*"tool":\s*"rstest"/);
  if (start < 0) return null;
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}
function seconds(step) {
  if (!step || step.status !== 'completed' || step.conclusion === 'skipped') return null;
  return (Date.parse(step.completedAt) - Date.parse(step.startedAt)) / 1000;
}
function fmt(value) { return value == null ? '—' : `${(value / 60).toFixed(2)} min`; }
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
async function update() {
  const run = JSON.parse(gh(['run', 'view', runId, '-R', repo, '--json', 'status,conclusion,headSha,jobs,url']));
  const rounds = [];
  for (const job of run.jobs) {
    const round = Number(job.name.match(/round (\d+)/)?.[1]);
    if (!round) continue;
    const stages = {};
    let log = '';
    if (job.status === 'completed') {
      const path = join(output, `round-${round}.log`);
      try { log = await readFile(path, 'utf8'); }
      catch {
        log = gh(['run', 'view', runId, '-R', repo, '--job', String(job.databaseId), '--log']);
        await writeFile(path, log);
      }
    }
    for (const [label, name] of [
      ['before', 'Original deterministic E2E, no retries'],
      ['retained', 'Retained deterministic E2E, no retries'],
      ['ai', 'All 153 AI cases, no retries'],
    ]) {
      const step = job.steps.find(step => step.name === name);
      const text = log.split('\n').filter(line => line.includes(`\t${name}\t`))
        .map(line => line.replace(/^.*?\t[^\t]+\t[^\s]+\s?/, '').replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
      const report = label === 'ai' ? null : jsonReport(text);
      const ai = text.match(/midscene-test: (\d+)\/(\d+) cases passed, (\d+) failed, (\d+) not run/);
      stages[label] = {
        status: step?.status ?? 'not_started',
        conclusion: step?.conclusion ?? '',
        seconds: seconds(step),
        counts: report?.summary ?? (ai ? { passedTests: +ai[1], tests: +ai[2], failedTests: +ai[3], notRun: +ai[4] } : null),
        tests: report?.tests?.map(({ fullName, testPath, status, retryCount, duration }) => ({ fullName, testPath, status, retryCount, duration })),
        aiAttempts: label === 'ai' ? [...text.matchAll(/([✓✗]) attempt (\d+)\/(\d+): (.*?) \((\d+) ms\)/g)]
          .map(([, marker, attempt, maxAttempts, name, duration]) => ({ name, passed: marker === '✓', attempt: +attempt, maxAttempts: +maxAttempts, durationMs: +duration })) : undefined,
      };
    }
    rounds.push({ round, status: job.status, conclusion: job.conclusion, url: job.url, ...stages });
  }
  rounds.sort((a, b) => a.round - b.round);
  const data = { updatedAt: new Date().toISOString(), ...run, jobs: undefined, rounds };
  await writeFile(join(output, 'results.json'), JSON.stringify(data, null, 2));
  const lines = [
    '# Rspress E2E migration measurements',
    '',
    `Run: ${run.url}`,
    `Updated: ${data.updatedAt}; status: ${run.status} / ${run.conclusion || 'pending'}`,
    '',
    'Pinned base e594d85; candidate 7fb151b. Three fresh Ubuntu 24.04 runners; Node 24; no test retries.',
    'Times below use GitHub step timestamps, include runner startup/teardown for the test command, and exclude dependency/build/report publication.',
    '',
    '| Round | Original E2E | Original passed/total | Retained E2E | Retained passed/total | AI E2E | Sequential after | Parallel critical path | AI passed/total | Failed/not run |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of rounds) {
    const counts = row.ai.counts;
    const completeTiming = row.retained.seconds != null && row.ai.seconds != null;
    const passCount = stage => stage.counts ? `${stage.counts.passedTests}/${stage.counts.tests}` : 'pending';
    lines.push(`| ${row.round} (${row.status}) | ${fmt(row.before.seconds)} | ${passCount(row.before)} | ${fmt(row.retained.seconds)} | ${passCount(row.retained)} | ${fmt(row.ai.seconds)} | ${fmt(completeTiming ? row.retained.seconds + row.ai.seconds : null)} | ${fmt(completeTiming ? Math.max(row.retained.seconds, row.ai.seconds) : null)} | ${passCount(row.ai)} | ${counts ? `${counts.failedTests}/${counts.notRun}` : 'pending'} |`);
  }
  const complete = rounds.filter(row => [row.before, row.retained, row.ai].every(stage => stage.counts && stage.seconds != null));
  if (complete.length === 3) {
    const before = complete.map(row => row.before.seconds);
    const after = complete.map(row => row.retained.seconds + row.ai.seconds);
    lines.push('', `Median before: ${fmt(median(before))}; median sequential after: ${fmt(median(after))}.`,
      `Median paired increase: ${fmt(median(complete.map((row, i) => after[i] - before[i])))}.`,
      `Median paired multiplier: ${median(complete.map((row, i) => after[i] / before[i])).toFixed(2)}x.`,
      `Before range: ${fmt(Math.min(...before))}–${fmt(Math.max(...before))}; after range: ${fmt(Math.min(...after))}–${fmt(Math.max(...after))}.`);
    const aiPassed = complete.reduce((sum, row) => sum + row.ai.counts.passedTests, 0);
    const aiTotal = complete.reduce((sum, row) => sum + row.ai.counts.tests, 0);
    const aiGreen = complete.filter(row => row.ai.conclusion === 'success' && row.ai.counts.passedTests === 153 && row.ai.counts.tests === 153).length;
    lines.push('', `AI first-attempt passes: ${aiPassed}/${aiTotal} (${(100 * aiPassed / aiTotal).toFixed(2)}%). Full AI rounds green: ${aiGreen}/3.`);
    const observed = new Map();
    for (const row of complete) {
      for (const test of row.ai.aiAttempts) {
        const list = observed.get(test.name) ?? [];
        list.push({ round: row.round, ...test });
        observed.set(test.name, list);
      }
    }
    const unstable = [...observed].filter(([, list]) => list.some(test => !test.passed) || list.length !== 3);
    lines.push('', '## AI cases requiring review', '');
    lines.push(...(unstable.length ? unstable.map(([name, list]) => `- ${name}: ${list.map(test => `round ${test.round} ${test.passed ? 'passed' : 'failed'}`).join(', ')}`) : ['No failed/inconsistently recorded cases among the observed attempt records. Cross-check missing cases against the native summaries.']));
  }
  lines.push('', 'Pass rate on an unchanged product measures stability, not defect-detection accuracy. Failures require manual review before labelling them false alarms.',
    'Coverage and case granularity differ. Do not call this an equal-work speed comparison. Three rounds do not support a reliable p95 or production accuracy claim.',
    'Native reports and precise monotonic timings are in the per-round workflow artifacts. Missing results remain missing; setup failures are not counted as passing tests.');
  await writeFile(join(output, 'REPORT.md'), lines.join('\n') + '\n');
  console.log(JSON.stringify({ updatedAt: data.updatedAt, status: run.status, rounds: rounds.map(row => ({ round: row.round, status: row.status, before: row.before.status, retained: row.retained.status, ai: row.ai.status })) }));
  return run.status === 'completed';
}
for (;;) {
  try { if (await update() || mode === '--once') break; }
  catch (error) { console.error(error.message); if (mode === '--once') throw error; }
  await setTimeout(60_000);
}
