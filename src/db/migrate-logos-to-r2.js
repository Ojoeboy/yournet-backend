// One-time migration: moves existing base64 data: URL logos (in
// tenants.account_logo and sites.portal_logo_url) out to R2 object storage,
// replacing each row's value with the resulting URL.
//
// Safe to run more than once - it only touches rows whose value still
// starts with 'data:', so already-migrated rows (URLs) are skipped.
//
// Requires R2_* env vars to be set (see .env.example) - refuses to run
// without them, since it would otherwise just be a no-op that silently
// leaves everything as base64.
//
// Run with: node src/db/migrate-logos-to-r2.js

require('dotenv').config();
const pool = require('./pool');
const storage = require('../services/storage');

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimetype: match[1], buffer: Buffer.from(match[2], 'base64') };
}

async function migrateTable(table, idCol, logoCol, prefix) {
  const { rows } = await pool.query(
    `SELECT ${idCol} AS id, ${logoCol} AS logo FROM ${table} WHERE ${logoCol} LIKE 'data:%'`
  );
  console.log(`${table}.${logoCol}: ${rows.length} base64 row(s) to migrate`);

  let migrated = 0;
  let failed = 0;
  for (const row of rows) {
    const parsed = parseDataUrl(row.logo);
    if (!parsed) {
      console.warn(`  skip ${row.id}: couldn't parse data URL`);
      failed++;
      continue;
    }
    try {
      const url = await storage.uploadLogo(parsed.buffer, parsed.mimetype, prefix);
      await pool.query(`UPDATE ${table} SET ${logoCol}=$1 WHERE ${idCol}=$2`, [url, row.id]);
      migrated++;
    } catch (err) {
      console.error(`  failed ${row.id}:`, err.message);
      failed++;
    }
  }
  console.log(`${table}.${logoCol}: migrated ${migrated}, failed ${failed}`);
  return { migrated, failed };
}

async function main() {
  if (!storage.isConfigured) {
    console.error('R2 env vars are not set (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME/R2_PUBLIC_URL). Set them first - see .env.example.');
    process.exit(1);
  }

  const a = await migrateTable('tenants', 'id', 'account_logo', 'account-logos');
  const b = await migrateTable('sites', 'id', 'portal_logo_url', 'portal-logos');

  console.log(`\nDone. Total migrated: ${a.migrated + b.migrated}, total failed: ${a.failed + b.failed}`);
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
