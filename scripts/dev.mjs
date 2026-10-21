/**
 * Runs the office in development mode: API server + Vite client.
 * Ctrl-C stops both processes.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');

const targets = [
  { name: 'server', command: 'npm', args: ['-w', 'server', 'run', 'dev'], color: '\u001b[38;5;180m' },
  { name: 'client', command: 'npm', args: ['-w', 'client', 'run', 'dev'], color: '\u001b[38;5;74m' },
];

const children = [];
let shuttingDown = false;

for (const target of targets) {
  const child = spawn(target.command, target.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `${target.color}[${target.name}]\u001b[0m`;
  const pipe = (stream, target_) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target_.write(`${prefix} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`${prefix} exited with code ${code ?? 0}.`);
    shutdown(code ?? 0);
  });

  children.push(child);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 150);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
