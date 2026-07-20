import { createRequire } from 'node:module';

// Read the version from package.json at runtime rather than importing it at
// compile time: package.json lives outside `rootDir`, and this keeps the
// version single-sourced (CLI banner + OTEL resource stay in sync). npm always
// ships package.json in the published tarball, so it resolves next to dist/.
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION = pkg.version;
