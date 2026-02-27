import { describe, it, expect } from 'vitest';
import { parseEnvLine } from '../../proxy/env-utils.js';

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

  it('returns empty string value for KEY= (empty value assignment)', () => {
    const r = parseEnvLine('KEY=');
    expect(r).toEqual({ key: 'KEY', value: '' });
  });
});
