const axios = require('axios');
const logger = require('../utils/logger');

// Rotating background photos via the Pexels API (pexels.com/api) - free,
// no per-image licensing cost, and Pexels' own license does NOT require
// attribution (unlike Unsplash's API terms), which matters here since we're
// showing photos in a rotating background with no natural place to caption
// "photo by X on Pexels" every 2 minutes.
//
// If PEXELS_API_KEY isn't set, this returns an empty list instead of
// crashing - same honest-stub pattern as emailService.js/smsService.js.
// An empty list just means the portal/dashboard falls back to whatever
// they'd otherwise show (a custom background image, or the plain mesh
// background) - never a broken <img> or a blank page.

const pexels = axios.create({
  baseURL: 'https://api.pexels.com/v1',
  headers: { Authorization: process.env.PEXELS_API_KEY || '' },
});

// One in-memory cache per search query, shared across all tenants/requests.
// Refreshed every 6 hours - these are generic themed backgrounds, not
// tenant-specific data, so there's no reason to hit the Pexels API on every
// page load.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map(); // query -> { urls: string[], fetchedAt: number }

async function fetchFromPexels(query, count) {
  const res = await pexels.get('/search', {
    params: { query, per_page: count, orientation: 'landscape' },
  });
  return res.data.photos.map((p) => p.src.large2x || p.src.large);
}

async function getRotatingBackgrounds(query = 'wifi network technology city', count = 12) {
  if (!process.env.PEXELS_API_KEY) {
    logger.warn('[BACKGROUNDS STUB - no PEXELS_API_KEY set] rotating backgrounds disabled');
    return [];
  }

  const cached = cache.get(query);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.urls;
  }

  try {
    const urls = await fetchFromPexels(query, count);
    cache.set(query, { urls, fetchedAt: Date.now() });
    return urls;
  } catch (err) {
    logger.error('Pexels fetch failed', { message: err.message });
    // Serve stale cache rather than nothing, if we have it.
    return cached ? cached.urls : [];
  }
}

module.exports = { getRotatingBackgrounds };
