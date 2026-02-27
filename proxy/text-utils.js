'use strict';

/**
 * Remove TUI artifacts from AgentAPI terminal output.
 *
 * AgentAPI already strips ANSI codes and TUI chrome via vt10x + screenDiff +
 * formatGenericMessage. This layer handles what remains after that:
 *
 *   1. ⏺ tool-use status lines → delete entire line
 *   2. Trailing right-pane fragments (after 2+ spaces) → strip suffix
 *      Examples: "esc to interrupt", "thought for 9s)", "↓ 1.8k tokens)"
 *   3. TUI box-drawing characters and misc symbols → strip inline
 *   4. Blank line normalization → collapse 2+ consecutive blank lines to 1
 *
 * @param {string} text - Raw AgentAPI response content
 * @returns {string} Cleaned text suitable for markdown rendering
 */
function cleanTuiOutput(text) {
    // Lines matching any of these patterns are noise — remove the whole line.
    const FULL_LINE_NOISE = [
        /^⏺/,                                              // any ⏺ tool-use line
        /^thought for \d+s\s*$/,                           // standalone "thought for Xs" line
        /Type your message or @path\/to\/file/,
        /Press 'i' for INSERT mode/,
    ];

    // Trailing right-pane status fragments: 2+ spaces then a known pattern.
    // AgentAPI collapses Claude Code's split-pane 80-col TUI so these bleed in.
    // Matches after 2+ spaces: esc to interrupt, ctrl+o to expand), timing fragments, token counts.
    const TRAILING_FRAGMENT = /\s{2,}(?:esc to interrupt|ctrl\+o to expand\)|to expand\)|thought for \d+s\)|[\d.]+s\s*[·•]\s*thought for \d+s\)|↓[^)]*\)|[\d.]+[ks]?\s*tokens[^)]*\)|\d+\.\d+s\)).*$/;

    // Trailing "thought for Xs" as a suffix after content (e.g. "Final answer — thought for 3s").
    // Separator can be em-dash, en-dash, hyphen, or simple whitespace.
    const THOUGHT_SUFFIX = /\s*[\u2014\u2013-]\s*thought for \d+s\s*$|\s+thought for \d+s\s*$/;

    return text
        .split('\n')
        .map(line => {
            // Remove whole-line noise.
            if (FULL_LINE_NOISE.some(re => re.test(line))) return '';

            // Strip trailing right-pane fragment (includes timing/token status).
            line = line.replace(TRAILING_FRAGMENT, '');

            // Strip trailing "thought for Xs" suffix (Bug 2 fix).
            line = line.replace(THOUGHT_SUFFIX, '');

            // Strip remaining TUI symbols not caught above.
            line = line.replace(/[⎿…▀▄░✦]/g, '');
            line = line.replace(/[┌┐└┘├┤┬┴┼─│]/g, '');

            return line.trimEnd();
        })
        .reduce((acc, line) => {
            // Collapse consecutive blank lines to max 1 (i.e., no double blank lines).
            if (line === '' && acc.length > 0 && acc[acc.length - 1] === '') {
                return acc;
            }
            return [...acc, line];
        }, [])
        .join('\n')
        .trim();
}

/**
 * Normalize markdown paragraph spacing for DingTalk rendering.
 * DingTalk requires \n\n between paragraphs and headings.
 * Ported from openclaw-channel-dingtalk/src/message-utils.ts.
 *
 * Rules:
 *   - Never inject blank lines inside fenced code blocks
 *   - After headings: always inject blank line
 *   - Between consecutive list items: no blank line
 *   - All other non-empty → non-empty transitions: inject blank line
 *   - Unclosed fence suppresses all injection for the remainder
 *
 * @param {string} text - Cleaned markdown text
 * @returns {string} Markdown with \n\n between paragraphs/headings
 */
function normalizeRagMarkdown(text) {
    const lines = text.split('\n');
    const result = [];
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const nextLine = lines[i + 1];
        result.push(line);

        // Toggle fenced code block state.
        if (/^```/.test(line)) {
            inFence = !inFence;
        }

        // Inside a code fence, never insert blank lines.
        if (inFence) continue;

        // Already followed by blank line or end of text — no action needed.
        if (nextLine === '' || nextLine === undefined) continue;

        const isCurrentHeading = /^#{1,6}\s/.test(line);
        const isCurrentListItem = /^[-*+]\s|^\d+\.\s/.test(line);
        const isNextListItem = /^[-*+]\s|^\d+\.\s/.test(nextLine);
        const isCurrentEmpty = line === '';

        // Never insert blank lines when current line is empty.
        if (isCurrentEmpty) continue;

        // Between two consecutive list items: no blank line.
        if (isCurrentListItem && isNextListItem) continue;

        // Insert blank line after headings.
        if (isCurrentHeading) { result.push(''); continue; }

        // Insert blank line in all other non-empty → non-empty transitions.
        result.push('');
    }

    return result.join('\n');
}

module.exports = { cleanTuiOutput, normalizeRagMarkdown };
