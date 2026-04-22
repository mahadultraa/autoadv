const { Pool } = require('pg');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

// railway provides DATABASE_URL for the attached postgres plugin
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('[DB] DATABASE_URL is not set. postgres persistence is disabled.');
}

// railway postgres requires ssl in production; local postgres usually does not
const useSsl =
  !!connectionString &&
  process.env.PGSSL !== 'false' &&
  !/localhost|127\.0\.0\.1/.test(connectionString);

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
      max: 10,
    })
  : null;

async function initSchema() {
  if (!pool) return;
  await pool.query(`
    create table if not exists app_state (
      key        text        primary key,
      value      jsonb       not null,
      updated_at timestamptz not null default now()
    )
  `);
}

async function loadState(key = 'veiled') {
  if (!pool) return null;
  const res = await pool.query('select value from app_state where key = $1', [key]);
  return res.rows[0] ? res.rows[0].value : null;
}

// coalesced writer. many mutations per request all collapse into one upsert.
let writing = false;
let pending = null;

async function flush() {
  if (writing || !pending || !pool) return;
  writing = true;
  const { key, data } = pending;
  pending = null;
  try {
    await pool.query(
      `insert into app_state (key, value, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (key) do update
         set value = excluded.value, updated_at = now()`,
      [key, JSON.stringify(data)]
    );
  } catch (e) {
    console.error('[DB] save error:', e.message);
  } finally {
    writing = false;
    if (pending) setImmediate(flush);
  }
}

function saveState(data, key = 'veiled') {
  if (!pool) return;
  pending = { key, data };
  setImmediate(flush);
}

function sessionStore() {
  if (!pool) return null;
  return new PgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  });
}

module.exports = { pool, initSchema, loadState, saveState, sessionStore };
