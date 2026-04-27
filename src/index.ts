#!/usr/bin/env node
import { Command } from 'commander';
import { runCli } from './modes/run.js';
import { runServe } from './modes/serve.js';

const program = new Command();

program
  .name('wally')
  .version('0.1.0', '-v, --version');

program
  .command('serve')
  .description('Start the HTTP server')
  .action(() => {
    runServe();
  });

program
  .command('run')
  .description('One-shot CLI run: read JSON from stdin, write a run record to stdout')
  .requiredOption('--config <path>', 'Path to agent config YAML')
  .action(async (options: { config: string }) => {
    // Absorb stray third-party stdout writes so only the final record reaches stdout.
    console.log = console.error;
    const code = await runCli({
      argv: ['--config', options.config],
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
    });
    process.exit(code);
  });

program.parseAsync().catch((err: unknown) => {
  process.stderr.write(
    `unhandled: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(2);
});
