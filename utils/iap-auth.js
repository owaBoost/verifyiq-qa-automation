/**
 * IAP authentication via Google-signed OIDC tokens.
 *
 * Requires:
 *   - GOOGLE_SA_KEY_FILE env var pointing to a service-account JSON key
 *   - IAP_CLIENT_ID env var (the OAuth client ID from GCP IAP settings)
 *
 * Usage:
 *   import { getGoogleIdToken } from './utils/iap-auth.js';
 *   const token = await getGoogleIdToken(process.env.IAP_CLIENT_ID);
 *   // token is a Google-signed OIDC id_token string (not prefixed with "Bearer ")
 */

import { GoogleAuth } from 'google-auth-library';

// Cache: audience -> { token, expiresAt }
const _cache = new Map();
const PRE_EXPIRY_BUFFER_S = 60;

let _auth = null;

function getAuth() {
  if (!_auth) {
    _auth = new GoogleAuth({
      keyFile: process.env.GOOGLE_SA_KEY_FILE,
    });
  }
  return _auth;
}

/**
 * Return a Google-signed OIDC id_token for the given target audience.
 * Tokens are cached per audience and refreshed 60 s before expiry.
 *
 * @param {string} targetAudience  The IAP OAuth Client ID (*.apps.googleusercontent.com)
 * @returns {Promise<string>}       The id_token string (use as `Authorization: Bearer <token>`)
 */
export async function getGoogleIdToken(targetAudience) {
  const now = Math.floor(Date.now() / 1000);
  const cached = _cache.get(targetAudience);
  if (cached && now < cached.expiresAt - PRE_EXPIRY_BUFFER_S) {
    return cached.token;
  }

  const auth = getAuth();
  const client = await auth.getIdTokenClient(targetAudience);
  const token = await client.idTokenProvider.fetchIdToken(targetAudience);

  // Decode exp from JWT payload (middle segment)
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const expiresAt = payload.exp || now + 3600;

  _cache.set(targetAudience, { token, expiresAt });
  console.log(`  \u2713 Google OIDC token generated (aud=${targetAudience.slice(0, 20)}..., expires in ${expiresAt - now}s)`);
  return token;
}
