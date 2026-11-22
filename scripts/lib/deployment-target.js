'use strict';

// Shared argument parsing and redaction for the read-only deployment scripts.
// Nothing in this module reads a database URL from the environment: an explicit
// connection input is always required from the operator.

const path = require('node:path');

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function usage(options) {
  const environments = (options.allowedEnvironments || ['branch', 'staging']).join('|');
  return `Usage: ${options.command} [options]

Required inputs (no defaults, no environment fallback):
  --environment <${environments}>   Explicit target class.
  --confirm-environment <name>   Repeat the environment value exactly.
  --project-ref <ref>             Explicit Supabase project ref or branch UUID.
  --db-url <postgres-url>         Explicit read-only connection string.
    or --db-url-stdin              Read the connection string from stdin instead.

Options:
  --dry-run                       Validate inputs and print the redacted plan only.
  --require-validated-constraints  Verify-only: fail while constraints are NOT VALID.
  -h, --help                      Show this help.

The scripts never apply migrations, never connect unless all inputs are valid,
never print the connection string, and refuse a production target unless it is
explicitly named and confirmed. Preflight refuses production entirely.`;
}

function parseArgs(argv, options = {}) {
  const allowedEnvironments = new Set(options.allowedEnvironments || ['branch', 'staging']);
  const supportsValidatedFlag = options.supportsValidatedFlag === true;
  const parsed = {
    help: false,
    dryRun: false,
    environment: null,
    confirmEnvironment: null,
    projectRef: null,
    dbUrl: null,
    dbUrlFromStdin: false,
    requireValidatedConstraints: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (flag) => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${flag} requires a value`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--environment':
        parsed.environment = takeValue(arg);
        break;
      case '--confirm-environment':
        parsed.confirmEnvironment = takeValue(arg);
        break;
      case '--project-ref':
        parsed.projectRef = takeValue(arg);
        break;
      case '--db-url':
        if (parsed.dbUrlFromStdin) throw new UsageError('use only one of --db-url or --db-url-stdin');
        parsed.dbUrl = takeValue(arg);
        break;
      case '--db-url-stdin':
        if (parsed.dbUrl !== null) throw new UsageError('use only one of --db-url or --db-url-stdin');
        parsed.dbUrlFromStdin = true;
        break;
      case '--require-validated-constraints':
        if (!supportsValidatedFlag) throw new UsageError(`unknown option: ${arg}`);
        parsed.requireValidatedConstraints = true;
        break;
      default:
        throw new UsageError(`unknown option: ${arg}`);
    }
  }

  if (parsed.help) return parsed;

  const missing = [];
  if (!parsed.environment) missing.push('--environment');
  if (!parsed.confirmEnvironment) missing.push('--confirm-environment');
  if (!parsed.projectRef) missing.push('--project-ref');
  if (parsed.dbUrl === null && !parsed.dbUrlFromStdin) missing.push('--db-url or --db-url-stdin');
  if (missing.length) {
    throw new UsageError(`missing explicit inputs: ${missing.join(', ')}`);
  }

  if (!allowedEnvironments.has(parsed.environment)) {
    throw new UsageError(
      `--environment must be one of ${[...allowedEnvironments].join(', ')}`
    );
  }
  if (parsed.confirmEnvironment !== parsed.environment) {
    throw new UsageError('--confirm-environment must exactly repeat --environment');
  }

  const ref = parsed.projectRef.trim();
  if (!/^[a-z]{20}$/i.test(ref) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
    throw new UsageError('--project-ref must be a 20-character project ref or a branch UUID');
  }
  parsed.projectRef = ref;

  if (parsed.dbUrlFromStdin) {
    const input = require('node:fs').readFileSync(0, 'utf8').trim();
    if (!input || /\s/.test(input)) {
      throw new UsageError('--db-url-stdin requires exactly one non-blank connection string');
    }
    parsed.dbUrl = input;
  }

  parsed.dbUrl = normalizeDbUrl(parsed.dbUrl);
  return parsed;
}

function normalizeDbUrl(raw) {
  const value = String(raw).trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new UsageError('--db-url must be a postgres:// or postgresql:// connection string');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new UsageError('--db-url must use the postgres or postgresql scheme');
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw new UsageError('--db-url must include a host and database name');
  }
  return value;
}

function redactSecrets(text, dbUrl) {
  let out = String(text == null ? '' : text);
  if (dbUrl) out = out.split(dbUrl).join('[redacted-db-url]');
  out = out.replace(/(postgres(?:ql)?:\/\/)[^\s/@]+:[^\s/@]*@/gi, '$1[redacted]@');
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\b/g, '[redacted-token]');
  out = out.replace(/\bsb_secret_[A-Za-z0-9_-]{8,}\b/g, '[redacted-token]');
  return out;
}

function printHelp(options, stream = process.stdout) {
  stream.write(`${usage(options)}\n`);
}

function describeTarget(parsed) {
  // Deliberately omit the connection string and any host details.
  return `environment=${parsed.environment} project-ref=${parsed.projectRef}`;
}

function repoPath(...segments) {
  return path.resolve(__dirname, '../..', ...segments);
}

module.exports = {
  UsageError,
  parseArgs,
  redactSecrets,
  printHelp,
  describeTarget,
  repoPath,
  usage,
};
