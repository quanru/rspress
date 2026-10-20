import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const [label, command, ...args] = process.argv.slice(2);
if (!label || !command) throw new Error('Expected label and command');
const output = join(process.env.GITHUB_WORKSPACE ?? process.cwd(), 'measurements');
await mkdir(output, { recursive: true });
const log = createWriteStream(join(output, `${label}.log`));
const startedAt = new Date().toISOString();
const started = performance.now();
const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', chunk => { process.stdout.write(chunk); log.write(chunk); });
child.stderr.on('data', chunk => { process.stderr.write(chunk); log.write(chunk); });
let spawnError;
child.on('error', error => { spawnError = error.message; });
const outcome = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
await new Promise(resolve => log.end(resolve));
await writeFile(join(output, `${label}.json`), JSON.stringify({
  label, round: Number(process.env.BENCHMARK_ROUND), startedAt,
  finishedAt: new Date().toISOString(), durationMs: performance.now() - started,
  ...outcome, spawnError,
  command: [command, ...args],
  node: process.version,
  ...(label === 'candidate-ai' ? {
    model: process.env.MIDSCENE_MODEL_NAME,
    family: process.env.MIDSCENE_MODEL_FAMILY,
  } : {}),
}, null, 2));
process.exitCode = outcome.code ?? 1;
