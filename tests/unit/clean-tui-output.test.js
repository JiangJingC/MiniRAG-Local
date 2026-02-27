import { describe, it, expect } from 'vitest';
import { cleanTuiOutput } from '../../proxy/text-utils.js';

describe('cleanTuiOutput', () => {
  // Bug 2: thought-for-Xs must strip only the trailing fragment, not the full line
  it('strips trailing "thought for Xs" fragment but keeps preceding content', () => {
    const input = 'Final answer — thought for 3s';
    const result = cleanTuiOutput(input);
    expect(result).toBe('Final answer');
  });

  it('removes a standalone "thought for Xs" line entirely', () => {
    const input = 'thought for 5s';
    const result = cleanTuiOutput(input);
    expect(result.trim()).toBe('');
  });

  // Bug 3: ⏺ tool-use lines removed entirely
  it('removes ⏺ tool-use lines with their content', () => {
    const input = '⏺ Searched for 2 patterns (ctrl+o to expand)';
    const result = cleanTuiOutput(input);
    expect(result.trim()).toBe('');
  });

  it('removes ⏺ Search(...) lines', () => {
    const input = '⏺ Search(pattern: "foo")';
    const result = cleanTuiOutput(input);
    expect(result.trim()).toBe('');
  });

  it('removes ⏺ Bash(...) lines', () => {
    const input = '⏺ Bash(echo hello)';
    const result = cleanTuiOutput(input);
    expect(result.trim()).toBe('');
  });

  // Bug 4: trailing right-pane fragments (after 2+ spaces)
  it('strips trailing "esc to interrupt" fragment', () => {
    const input = 'Analyzing your question  esc to interrupt';
    const result = cleanTuiOutput(input);
    expect(result).toBe('Analyzing your question');
  });

  it('strips trailing timing fragment', () => {
    const input = 'Processing  12.3s · thought for 9s)';
    const result = cleanTuiOutput(input);
    expect(result).toBe('Processing');
  });

  it('strips trailing token status fragment', () => {
    const input = 'Response text  ↓ 1.8k tokens)';
    const result = cleanTuiOutput(input);
    expect(result).toBe('Response text');
  });

  it('strips trailing "ctrl+o to expand)" fragment', () => {
    const input = 'Some content  ctrl+o to expand)';
    const result = cleanTuiOutput(input);
    expect(result).toBe('Some content');
  });

  // Regression: existing patterns must still work
  it('removes box-drawing characters', () => {
    const input = '┌──────┐\n│ text │\n└──────┘';
    const result = cleanTuiOutput(input);
    expect(result).not.toMatch(/[┌┐└┘│─]/);
  });

  it('removes Type-your-message TUI prompt line', () => {
    const input = "real content\nType your message or @path/to/file";
    const result = cleanTuiOutput(input);
    expect(result).not.toContain('Type your message');
    expect(result).toContain('real content');
  });

  // Blank line collapsing still works
  it('collapses 3+ consecutive blank lines to max 2', () => {
    const input = 'a\n\n\n\nb';
    const result = cleanTuiOutput(input);
    expect(result).toBe('a\n\nb');
  });
});
