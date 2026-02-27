import { describe, it, expect } from 'vitest';
import { normalizeRagMarkdown } from '../../proxy/text-utils.js';

describe('normalizeRagMarkdown', () => {
  it('adds blank line after heading when followed immediately by content', () => {
    expect(normalizeRagMarkdown('## hwclock 命令总结\n这是一个命令'))
      .toBe('## hwclock 命令总结\n\n这是一个命令');
  });

  it('does not double-space when blank line already present', () => {
    expect(normalizeRagMarkdown('## heading\n\n已经有空行了'))
      .toBe('## heading\n\n已经有空行了');
  });

  it('adds blank line between prose paragraphs separated by single newline', () => {
    expect(normalizeRagMarkdown('第一段内容\n第二段内容'))
      .toBe('第一段内容\n\n第二段内容');
  });

  it('preserves existing blank lines', () => {
    expect(normalizeRagMarkdown('段落一\n\n段落二\n\n段落三'))
      .toBe('段落一\n\n段落二\n\n段落三');
  });

  it('does not add blank line between list items', () => {
    expect(normalizeRagMarkdown('- item1\n- item2\n- item3'))
      .toBe('- item1\n- item2\n- item3');
  });

  it('returns text unchanged if already well-formatted', () => {
    expect(normalizeRagMarkdown('# Title\n\n段落内容\n\n- list item'))
      .toBe('# Title\n\n段落内容\n\n- list item');
  });

  it('adds blank line before list when preceded by prose', () => {
    expect(normalizeRagMarkdown('介绍说明\n- item1\n- item2'))
      .toBe('介绍说明\n\n- item1\n- item2');
  });

  it('adds blank line after list when followed by prose', () => {
    expect(normalizeRagMarkdown('- item1\n- item2\n总结内容'))
      .toBe('- item1\n- item2\n\n总结内容');
  });

  it('does not inject blank lines inside fenced code blocks', () => {
    expect(normalizeRagMarkdown('说明\n```bash\nhwclock -r\n```\n下一段'))
      .toBe('说明\n\n```bash\nhwclock -r\n```\n\n下一段');
  });

  it('adds blank line between list and heading', () => {
    expect(normalizeRagMarkdown('- item\n## Section\n内容'))
      .toBe('- item\n\n## Section\n\n内容');
  });

  it('treats unclosed fence as in-fence for remainder, suppressing blank-line insertion', () => {
    expect(normalizeRagMarkdown('intro\n```bash\ncode line one\ncode line two'))
      .toBe('intro\n\n```bash\ncode line one\ncode line two');
  });
});
