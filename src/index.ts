#!/usr/bin/env node
import { Command } from 'commander';
import { runCli } from './modes/run.js';
import { runServe } from './modes/serve.js';
import { VERSION } from './version.js';

const program = new Command();

program.name('configurable-agent').version(VERSION, '-v, --version');

program
  .command('serve')
  .description('Start the HTTP server')
  .action(async () => {
    await runServe();
  });

program
  .command('run')
  .description('One-shot CLI run: read JSON from stdin, write a run record to stdout')
  .requiredOption('--config <path>', 'Path to agent config YAML')
  .action(async (options: { config: string }) => {
    // Absorb stray third-party stdout writes so only the final record reaches
    // stdout — info/debug also target stdout, not just log.
    console.log = console.error;
    console.info = console.error;
    console.debug = console.error;
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
