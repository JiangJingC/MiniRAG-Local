'use strict';

/**
 * Parse a single .env file line.
 * Splits on the first `=` only, so values containing `=` (e.g. JSON) are preserved.
 *
 * @param {string} line - A single line from a .env file
 * @returns {{ key: string, value: string } | null} Parsed key/value, or null if line is not a valid assignment
 */
function parseEnvLine(line) {
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) return null;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (!key) return null;
    return { key, value };
}

module.exports = { parseEnvLine };
