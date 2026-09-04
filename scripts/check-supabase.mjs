// Validates a Supabase DATABASE_URL before the API is started against it.
// Usage: node scripts/check-supabase.mjs "postgresql://..."
import pg from '../apps/api/node_modules/pg/lib/index.js';

const url = process.argv[2] ?? process.env.DATABASE_URL;
if (!url) { console.error('Pass the connection string as the first argument.'); process.exit(1); }

const parsed = new URL(url);
const notes = [];
if (parsed.password.includes('[') || parsed.password.includes('YOUR-PASSWORD')) notes.push('Password is still the placeholder — paste your real one.');
if (parsed.port === '6543') notes.push('Port 6543 is the Transaction pooler; the API needs a session connection on 5432.');
if (parsed.hostname.startsWith('db.') && parsed.hostname.endsWith('supabase.co')) {
  notes.push('This is the Direct connection, which is IPv6-only. This machine has no IPv6 — use the Session pooler string instead (host contains "pooler.supabase.com").');
}
if (!parsed.searchParams.has('sslmode')) notes.push('No sslmode set — append ?sslmode=require (Supabase requires TLS).');
for (const note of notes) console.log('WARN  ' + note);

const pool = new pg.Pool({ connectionString: url, max: 1, statement_timeout: 15_000, connectionTimeoutMillis: 15_000 });
try {
  const { rows } = await pool.query('select current_database() db, version() v');
  console.log(`OK    connected to "${rows[0].db}"`);
  console.log('      ' + rows[0].v.split(',')[0]);
  const ext = await pool.query("select 1 from pg_extension where extname = 'vector'");
  console.log(ext.rowCount ? 'OK    pgvector extension is enabled' : 'WARN  pgvector is NOT enabled (Part 2 of the guide)');
  const t = await pool.query("select count(*)::int n from information_schema.tables where table_schema='public'");
  console.log(`      ${t.rows[0].n} tables currently in public schema (expect 0 before first API start, ~32 after)`);
} catch (error) {
  console.log('FAIL  ' + error.message);
  process.exitCode = 1;
} finally { await pool.end(); }
