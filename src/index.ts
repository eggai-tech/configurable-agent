#!/usr/bin/env node
import { runCli } from './modes/run.js';
import { runServe } from './modes/serve.js';

const VERSION = '0.1.0';

const USAGE = `Usage:
  wally serve                              Start the HTTP server.
  wally run --config <path-to-config>     One-shot CLI run: read JSON from stdin, write a run record to stdout.
  wally --version                          Print the wally version and exit.
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case '--version':
    case '-v':
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return;
    case 'serve':
      runServe();
      return;
    case 'run': {
      // Absorb stray third-party stdout writes so only the final record reaches stdout.
      console.log = console.error;
      const code = await runCli({
        argv: rest,
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
      });
      process.exit(code);
      return;
    }
    default:
      process.stderr.write(USAGE);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(
    `unhandled: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(2);
});
