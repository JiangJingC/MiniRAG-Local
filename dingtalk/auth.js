'use strict';

let _cachedToken = null;
let _expiresAt = 0;

/**
 * Get a valid DingTalk access token, refreshing if within 60s of expiry.
 * @param {string} appKey
 * @param {string} appSecret
 * @returns {Promise<string>}
 */
async function getAccessToken(appKey, appSecret) {
    const now = Date.now();
    if (_cachedToken && now < _expiresAt - 60_000) {
        return _cachedToken;
    }

    const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey, appSecret, grantType: 'client_credentials' }),
    });

    if (!res.ok) {
        throw new Error(`Token fetch failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    _cachedToken = data.accessToken;
    _expiresAt = now + data.expireIn * 1000;
    return _cachedToken;
}

/** Reset cache (for testing) */
function resetCache() {
    _cachedToken = null;
    _expiresAt = 0;
}

module.exports = { getAccessToken, resetCache };
