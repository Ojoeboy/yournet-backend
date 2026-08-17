// Cloudflare R2 storage service (S3-compatible API) for tenant/portal logos.
// Replaces storing base64 data: URLs directly in Postgres (tenants.account_logo,
// sites.portal_logo_url), which was inflating row size ~33% per image and
// eating into Neon's 0.5GB free-tier storage cap as tenant count grows.
//
// Required env vars (see .env.example):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL
//
// If R2 env vars are not set, uploadLogo() falls back to returning a base64
// data: URL (old behavior) so local dev / testing without R2 keys still works.

const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
// Public base URL for the bucket - either the r2.dev dev subdomain Cloudflare
// gives you, or a custom domain you've mapped to the bucket. No trailing slash.
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

const isConfigured = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME && R2_PUBLIC_URL);

let client = null;
if (isConfigured) {
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
} else {
  console.warn('[storage] R2 env vars not set - logo uploads will fall back to base64 data: URLs in Postgres. Set R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME/R2_PUBLIC_URL to enable R2.');
}

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Uploads a logo buffer to R2 and returns its public URL.
 * Falls back to a base64 data: URL if R2 isn't configured.
 *
 * @param {Buffer} buffer - raw file bytes (e.g. from multer memoryStorage)
 * @param {string} mimetype - e.g. 'image/png'
 * @param {string} prefix - key prefix, e.g. 'account-logos' or 'portal-logos'
 * @returns {Promise<string>} the URL to store in the DB
 */
async function uploadLogo(buffer, mimetype, prefix) {
  if (!isConfigured) {
    return `data:${mimetype};base64,${buffer.toString('base64')}`;
  }
  const ext = EXT_BY_MIME[mimetype] || 'bin';
  const key = `${prefix}/${crypto.randomUUID()}.${ext}`;

  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimetype,
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return `${R2_PUBLIC_URL}/${key}`;
}

/**
 * Deletes a previously-uploaded logo given its stored URL. Safe to call with
 * a base64 data: URL (old rows) or a URL that isn't under this bucket - it's
 * a no-op in those cases, since there's nothing in R2 to remove.
 *
 * @param {string|null} url
 */
async function deleteLogo(url) {
  if (!isConfigured || !url || !url.startsWith(R2_PUBLIC_URL + '/')) return;
  const key = url.slice((R2_PUBLIC_URL + '/').length);
  try {
    await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  } catch (err) {
    // Non-fatal - an orphaned object in the bucket costs nothing to speak of
    // and shouldn't block the request (logo delete/replace) that triggered this.
    console.warn('[storage] failed to delete R2 object', key, err.message);
  }
}

module.exports = { uploadLogo, deleteLogo, isConfigured };
