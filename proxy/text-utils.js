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
 *   4. Blank line normalization → collapse >2 consecutive blank lines to 2
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

module.exports = { cleanTuiOutput };
