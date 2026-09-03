// DESTRUCTIVE one-time script: wipes ALL tenants and sites, plus every
// table that references them (tenant_users, packages, vouchers, licenses,
// payments, PPPoE plans/subscribers/payments, agent activity log, etc.)
// via TRUNCATE ... CASCADE.
//
// Before truncating, it walks every tenants.account_logo and
// sites.portal_logo_url value and deletes the matching object from R2 (via
// storage.deleteLogo, which is a safe no-op for base64 data: URLs or when
// R2 isn't configured), so you don't leave orphaned files in the bucket
// behind a now-empty database.
//
// Refuses to run without --yes, since there is no undo: TRUNCATE CASCADE
// is not a soft delete and this is not scoped to "test" rows - it clears
// every tenant.
//
// SAFETY CHECK: if DATABASE_URL points at anything other than localhost
// (i.e. a real/remote database - which any Neon connection string will be),
// --yes alone is not enough. The script also prints the target host and
// requires you to type that exact host back to confirm, so pointing this
// at production by accident (e.g. forgetting your local .env still has the
// live DATABASE_URL in it) can't slip through on muscle-memory alone.
//
// Run with: node src/db/wipe-tenants.js --yes

require('dotenv').config();
const readline = require('readline');
const pool = require('./pool');
const storage = require('../services/storage');

function getDbHost() {
  try {
    return new URL(process.env.DATABASE_URL).hostname;
  } catch {
    return null;
  }
}

function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

async function confirmRemoteTarget(host) {
  console.log(`\nDATABASE_URL points at a remote host: ${host}`);
  console.log('This does not look like a local database, so this is almost certainly production or a shared environment.\n');
  const typed = await ask(`Type the host exactly ("${host}") to confirm you mean to wipe THIS database: `);
  if (typed.trim() !== host) {
    console.error('\nInput did not match. Refusing to run - nothing was touched.');
    process.exit(1);
  }
  console.log('Confirmed. Proceeding.\n');
}

async function purgeLogos() {
  const { rows: tenantRows } = await pool.query(
    `SELECT account_logo AS logo FROM tenants WHERE account_logo IS NOT NULL`
  );
  const { rows: siteRows } = await pool.query(
    `SELECT portal_logo_url AS logo FROM sites WHERE portal_logo_url IS NOT NULL`
  );
  const all = [...tenantRows, ...siteRows];
  console.log(`Purging ${all.length} logo object(s) from R2 (no-op for any base64 rows)...`);

  let purged = 0;
  let failed = 0;
  for (const row of all) {
    try {
      await storage.deleteLogo(row.logo);
      purged++;
    } catch (err) {
      console.warn(`  failed to delete logo: ${err.message}`);
      failed++;
    }
  }
  console.log(`Logo purge done: ${purged} attempted, ${failed} failed (failures are non-fatal).`);
}

async function wipe() {
  console.log('Truncating tenants, sites CASCADE (this clears every dependent table)...');
  await pool.query('TRUNCATE TABLE tenants, sites RESTART IDENTITY CASCADE');
  console.log('Done. Database is back to a clean, tenant-free state.');
}

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error(
      'Refusing to run: this permanently deletes ALL tenants, sites, and every ' +
      'row that references them (users, vouchers, licenses, payments, PPPoE ' +
      'data, etc.), plus their R2 logo objects. There is no undo.\n\n' +
      'Re-run with --yes if you are sure:\n  node src/db/wipe-tenants.js --yes'
    );
    process.exit(1);
  }

  const host = getDbHost();
  if (!host) {
    console.error('Could not parse DATABASE_URL - refusing to run.');
    process.exit(1);
  }
  if (!isLocalHost(host)) {
    await confirmRemoteTarget(host);
  }

  try {
    await purgeLogos();
    await wipe();
  } catch (err) {
    console.error('Wipe failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
