// Run with: node src/db/audit-constraints.js
//
// Why this exists: CREATE TABLE IF NOT EXISTS silently does nothing when a
// table already exists - including skipping any NOT NULL/UNIQUE written
// inline in that CREATE TABLE block. We've already found two real cases of
// this (sites.active, tenants.owner_email) where the schema file claimed a
// constraint that the live database never actually had. This script checks
// every table for the same gap, instead of finding them one at a time by
// accident.
//
// It does NOT change anything - read-only, safe to run anytime, including
// against production. Reports mismatches; fixing any it finds means writing
// a migration step the same way the sites.active/owner_email fixes were
// done (handle existing bad data first, then add the real constraint).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Deliberately not reusing src/db/pool.js here: the live app connects to
// Postgres from inside Render's network, where plain TCP is fine. Running
// this script from a laptop against Render's *external* connection string
// almost always needs SSL, so this one-off diagnostic pool enables it
// whenever the host looks like a Render Postgres host - doesn't affect the
// app's own pool at all.
const isRenderHost = /render\.com/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRenderHost ? { rejectUnauthorized: false } : false,
});

const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

// ---- Parse what schema.sql *claims* ----

function parseDeclaredConstraints(sql) {
  const tables = {}; // { tableName: { notNull: Set<col>, unique: [ [col,...], ... ] } }

  const tableBlocks = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)];

  for (const [, tableName, body] of tableBlocks) {
    const notNull = new Set();
    const unique = [];

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,\s*$/, '');
      if (!line || line.startsWith('--')) continue;

      // Table-level UNIQUE(col1, col2)
      const tableUnique = line.match(/^UNIQUE\s*\(([^)]+)\)/i);
      if (tableUnique) {
        unique.push(tableUnique[1].split(',').map((c) => c.trim()));
        continue;
      }

      // Column-level: first token is the column name
      const colMatch = line.match(/^(\w+)\s+/);
      if (!colMatch) continue;
      const col = colMatch[1];
      if (/\bNOT NULL\b/i.test(line) && !/\bDEFAULT\b/i.test(line)) {
        // Only flag NOT NULL columns *without* a DEFAULT - those are the
        // ones that would actually fail to backfill safely if missing;
        // NOT NULL DEFAULT x is what the safe ALTER TABLE ADD COLUMN
        // pattern already used elsewhere in this file looks like.
        notNull.add(col);
      }
      if (/\bUNIQUE\b/i.test(line)) {
        unique.push([col]);
      }
    }

    tables[tableName] = { notNull, unique };
  }

  return tables;
}

// ---- Query what the live database *actually has* ----

async function getLiveNotNullColumns(tableName) {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = $1 AND is_nullable = 'NO'`,
    [tableName]
  );
  return new Set(rows.map((r) => r.column_name));
}

async function getLiveUniqueColumnSets(tableName) {
  const { rows } = await pool.query(
    `SELECT tc.constraint_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.table_name = $1 AND tc.constraint_type IN ('UNIQUE', 'PRIMARY KEY')
     ORDER BY tc.constraint_name, kcu.ordinal_position`,
    [tableName]
  );
  const byConstraint = {};
  for (const r of rows) {
    (byConstraint[r.constraint_name] ||= []).push(r.column_name);
  }
  return Object.values(byConstraint); // array of column-sets, e.g. [['owner_email'], ['tenant_id','email']]
}

async function tableExists(tableName) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
    [tableName]
  );
  return rows.length > 0;
}

// ---- Compare and report ----

async function audit() {
  const declared = parseDeclaredConstraints(schemaSql);
  let problems = 0;

  console.log(`Auditing ${Object.keys(declared).length} table(s) declared in schema.sql against the live database...\n`);

  for (const [tableName, { notNull, unique }] of Object.entries(declared)) {
    if (!(await tableExists(tableName))) {
      console.log(`- ${tableName}: table doesn't exist in the live DB yet (fine if you haven't migrated recently).`);
      continue;
    }

    const liveNotNull = await getLiveNotNullColumns(tableName);
    const liveUniqueSets = await getLiveUniqueColumnSets(tableName);

    const missingNotNull = [...notNull].filter((c) => !liveNotNull.has(c));
    const missingUnique = unique.filter(
      (declaredCols) =>
        !liveUniqueSets.some(
          (liveCols) =>
            liveCols.length === declaredCols.length &&
            liveCols.every((c) => declaredCols.includes(c))
        )
    );

    if (missingNotNull.length === 0 && missingUnique.length === 0) {
      console.log(`OK  ${tableName}`);
      continue;
    }

    problems++;
    console.log(`MISMATCH  ${tableName}`);
    for (const col of missingNotNull) {
      console.log(`   - schema.sql says "${col}" is NOT NULL, but the live column allows NULL.`);
    }
    for (const cols of missingUnique) {
      console.log(`   - schema.sql says UNIQUE(${cols.join(', ')}), but no matching constraint exists live.`);
    }
  }

  console.log(
    problems === 0
      ? '\nNo gaps found - every declared NOT NULL/UNIQUE constraint is actually enforced live.'
      : `\n${problems} table(s) have a constraint schema.sql claims but the live database doesn't enforce. ` +
        `Each one needs a migration step written the same way the sites.active/owner_email fixes were done - ` +
        `check for existing bad data first, then add the real constraint.`
  );

  await pool.end();
}

audit().catch((err) => {
  console.error('Audit failed:', err.message);
  process.exit(1);
});
