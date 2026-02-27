import { describe, it, expect } from 'vitest';

// Test the parsing logic in isolation.
// Mirror the fix we'll implement in loadEnv().
function parseEnvLine(line) {
  const eqIdx = line.indexOf('=');
  if (eqIdx === -1) return null;
  const key = line.slice(0, eqIdx).trim();
  const value = line.slice(eqIdx + 1).trim();
  if (!key || !value) return null;
  return { key, value };
}

describe('loadEnv line parser', () => {
  it('parses a simple key=value', () => {
    const r = parseEnvLine('PORT=8000');
    expect(r).toEqual({ key: 'PORT', value: '8000' });
  });

  it('preserves = signs in the value (JSON with nested =)', () => {
    const r = parseEnvLine('DINGTALK_RAG_GROUPS={"groupA":"http://a?x=1"}');
    expect(r).toEqual({
      key: 'DINGTALK_RAG_GROUPS',
      value: '{"groupA":"http://a?x=1"}',
    });
  });

  it('trims whitespace around key', () => {
    const r = parseEnvLine('  MY_KEY  =my value');
    expect(r).toEqual({ key: 'MY_KEY', value: 'my value' });
  });

  it('returns null for lines without =', () => {
    expect(parseEnvLine('NO_EQUALS_HERE')).toBeNull();
    expect(parseEnvLine('# comment')).toBeNull();
    expect(parseEnvLine('')).toBeNull();
  });

  it('returns null for lines with empty key', () => {
    expect(parseEnvLine('=somevalue')).toBeNull();
  });
});
