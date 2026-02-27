'use strict';

/**
 * Remove TUI artifacts from AgentAPI terminal output and produce clean markdown.
 *
 * Processing pipeline (order matters):
 *
 *   Phase 0 — Structural conversion (before any character stripping)
 *     0a. Convert box-drawing tables (┌─┬┐ … └─┘) → bold key-value list
 *     0b. Convert rounded-corner boxes (╭─╮ … ╰─╯) → strip (welcome banner etc.)
 *     0c. Convert markdown tables (| col | col |) → bold key-value list
 *     (DingTalk markdown does NOT support GFM table syntax)
 *
 *   Phase 1 — Whole-line noise removal
 *     - ⏺ tool-use status lines
 *     - ⏵⏵ auto-accept status lines
 *     - "thought for Xs" standalone lines
 *     - TUI prompt / input hints
 *     - Truncation markers: "… +N lines (ctrl+o to expand)"
 *     - ⎿ tool result continuation lines (indented)
 *
 *   Phase 2 — Trailing fragment stripping
 *     - Right-pane status: "esc to interrupt", "ctrl+o to expand)", token counts
 *     - "thought for Xs" suffixes after content
 *     - "(ctrl+r to expand)" inline hints
 *
 *   Phase 3 — Inline character cleanup
 *     - Remaining TUI symbols: ⎿ ▀ ▄ ░ ✦ ● ✻ ⏺ ⏵
 *     - Remaining box-drawing characters (not caught by Phase 0)
 *
 *   Phase 4 — Blank line normalization
 *     - Collapse 2+ consecutive blank lines to 1
 *
 * @param {string} text - Raw AgentAPI response content
 * @returns {string} Cleaned text suitable for markdown rendering
 */
/**
 * Convert parsed table rows into a DingTalk-friendly bold-list format.
 *
 * 2-column tables (most common — key/value):
 *   **key1**: value1
 *   **key2**: value2
 *
 * 3+ column tables:
 *   **col1** / **col2** / **col3**     ← header (all bold)
 *   val1 / val2 / val3                 ← data rows
 *
 * @param {string[][]} rows - Array of rows, first row is header
 * @returns {string}
 */
function convertRowsToBoldList(rows) {
    const header = rows[0];
    const data = rows.slice(1);

    if (header.length === 2) {
        // Key-value style → markdown list items so DingTalk renders each on its own line.
        // DingTalk markdown collapses single-\n paragraph text into one line, but
        // list items (- prefix) are always rendered as separate lines.
        //
        // Output:
        //   - **key1**: value1
        //   - **key2**: value2
        const lines = [];
        if (data.length === 0) {
            lines.push(`- **${header[0]}**: ${header[1]}`);
        } else {
            for (const row of data) {
                lines.push(`- **${row[0]}**: ${row[1]}`);
            }
        }
        return lines.join('\n');
    }

    // 3+ columns → list items as well.
    // Header: bold labels joined with " / ", prefixed with "- "
    // Data rows: plain values joined with " / ", prefixed with "- "
    // When a data row's first cell is empty (merged cell / continuation),
    // inherit the previous row's first cell value.
    const headerLine = '- ' + header.map(h => `**${h}**`).join(' / ');
    let lastFirstCell = '';
    const dataLines = data.map(row => {
        if (row[0] === '') {
            row = [lastFirstCell, ...row.slice(1)];
        } else {
            lastFirstCell = row[0];
        }
        return '- ' + row.join(' / ');
    });
    return [headerLine, ...dataLines].join('\n');
}

/**
 * Detect and convert GFM markdown tables (| col | col |) in text.
 * These won't render in DingTalk's limited markdown. Convert to bold-list format.
 *
 * A markdown table block is identified as:
 *   - 2+ contiguous lines starting/containing |
 *   - With a separator row matching | ---+ | ---+ | (with optional colons for alignment)
 *
 * @param {string} text
 * @returns {string}
 */
function convertMarkdownTables(text) {
    const lines = text.split('\n');
    const result = [];
    let i = 0;

    while (i < lines.length) {
        // Look for potential table start: line with at least one | ... | pattern
        if (/^\s*\|/.test(lines[i])) {
            // Collect contiguous pipe-delimited lines
            const tableLines = [];
            let j = i;
            while (j < lines.length && /^\s*\|/.test(lines[j])) {
                tableLines.push(lines[j]);
                j++;
            }

            // Must have at least 2 lines (header + separator, or header + separator + data)
            // and one of them must be a separator row
            const sepIdx = tableLines.findIndex(l => /^\s*\|[\s:]*-{2,}[\s:|-]*\|\s*$/.test(l));

            if (tableLines.length >= 2 && sepIdx !== -1) {
                // Parse into rows, excluding separator
                const rows = tableLines
                    .filter((_, idx) => idx !== sepIdx)
                    .map(line =>
                        line.split('|').slice(1, -1).map(cell => cell.trim())
                    )
                    .filter(row => row.length > 0 && row.some(cell => cell !== ''));

                if (rows.length > 0 && rows[0].length > 0) {
                    result.push(convertRowsToBoldList(rows));
                    i = j;
                    continue;
                }
            }

            // Not a valid table — keep lines as-is
            result.push(lines[i]);
            i++;
        } else {
            result.push(lines[i]);
            i++;
        }
    }

    return result.join('\n');
}

/**
 * Convert ASCII directory tree blocks to markdown list format.
 *
 * Detects contiguous runs of lines containing ├──, └──, or │ (box-drawing
 * tree characters), and converts them to indented markdown lists so that
 * normalizeRagMarkdown treats consecutive entries as list items (no blank
 * lines between them).
 *
 * The optional 2-space TUI indent on every line is stripped first.
 * Depth is inferred from the number of leading │ segments before ├/└.
 *
 * @param {string} text
 * @returns {string}
 */
function convertTreeBlocks(text) {
    const lines = text.split('\n');
    const result = [];
    let i = 0;

    // A line is a "tree line" if it contains ├, └, or starts with │ (after
    // optional leading spaces from TUI indent).
    const isTreeLine = (l) => /^\s*(?:├|└|│)/.test(l);

    while (i < lines.length) {
        if (!isTreeLine(lines[i])) {
            result.push(lines[i]);
            i++;
            continue;
        }

        // Collect the contiguous tree block.
        const block = [];
        while (i < lines.length && (isTreeLine(lines[i]) || lines[i].trim() === '')) {
            block.push(lines[i]);
            i++;
        }

        // Convert each tree line to a markdown list item.
        for (const rawLine of block) {
            if (rawLine.trim() === '') {
                // Blank lines inside tree block: skip (will be re-added by Phase 4 if needed)
                continue;
            }

            // Strip 2-space TUI indent from the start.
            const line = rawLine.replace(/^ {1,2}/, '');

            // Determine depth from the prefix before ├/└.
            // Two styles of tree indentation:
            //   a) "│   ├── foo"  — │ + spaces repeated per level
            //   b) "    ├── foo"  — pure spaces (4 per level) when parent used └──
            //
            // Count pipe characters first; if none found, estimate from space count.
            const prefixMatch = line.match(/^((?:│\s*|\s{4})+)(?=[├└])/);
            let depth = 0;
            if (prefixMatch) {
                const prefix = prefixMatch[1];
                const pipeCount = (prefix.match(/│/g) || []).length;
                if (pipeCount > 0) {
                    depth = pipeCount;
                } else {
                    // Count groups of 4 spaces
                    depth = Math.round(prefix.length / 4);
                }
            }

            // Strip tree characters: everything up to and including ├──/└──.
            let content = line
                .replace(/^(?:(?:│\s*|\s{4})+)?[├└]──\s*/, '')  // remove tree prefix + ├── or └──
                .replace(/^│\s*$/, '')                             // pure │ spacer → empty
                .trimEnd();

            if (content === '') continue; // skip pure spacer lines

            const indent = '  '.repeat(depth);
            result.push(`${indent}- ${content}`);
        }
    }

    return result.join('\n');
}

function cleanTuiOutput(text) {

    // ── Phase 0a: Convert box-drawing tables to bold-list format ─────────────
    // DingTalk markdown does NOT support GFM table syntax (| col | col |).
    // Convert box-drawing tables to a bold key-value list that DingTalk renders:
    //
    //   ┌──────┬──────┐       **项目**: 说明
    //   │ 项目 │ 说明 │  →    **源码路径**: ~/code/koal/gw-cloud-dms/
    //   ├──────┼──────┤       **技术栈**: Go + Gorilla Mux
    //   │ 源码 │ Go   │
    //   └──────┴──────┘
    //
    // For tables with 3+ columns, format as: **col1** / **col2** / **col3**
    // followed by value lines: val1 / val2 / val3
    //
    // Must run BEFORE character-level stripping so table structure is preserved.
    const boxTableRe = /(?:^|\n)([ \t]*[┌╔][─═┬╦]+[┐╗][\s\S]*?[└╚][─═┴╩]+[┘╝])/g;

    text = text.replace(boxTableRe, (_match, table) => {
        const lines = table.split('\n');
        const dataLines = lines.filter(l => /[│║]/.test(l));

        if (dataLines.length === 0) return _match; // not parsable, leave as-is

        const rows = dataLines.map(line =>
            line.split(/[│║]/).slice(1, -1).map(cell => cell.trim())
        );

        if (rows.length === 0 || rows[0].length === 0) return _match;

        return '\n' + convertRowsToBoldList(rows);
    });

    // ── Phase 0b: Strip rounded-corner boxes (welcome banner, decorative) ──
    // ╭────────────╮ ... ╰────────────╯  →  delete entire block
    const roundedBoxRe = /(?:^|\n)[ \t]*╭[─╌]+╮[\s\S]*?╰[─╌]+╯/g;
    text = text.replace(roundedBoxRe, '');

    // ── Phase 0c: Convert markdown tables (| col | col |) to bold-list ────
    // DingTalk does not render GFM table syntax. Detect contiguous blocks of
    // pipe-delimited rows (with a separator row like | --- | --- |) and convert.
    text = convertMarkdownTables(text);

    // ── Phase 0d: Convert ASCII directory trees to markdown lists ─────────
    // Claude outputs file trees using box-drawing characters: ├── │ └──
    // These survive table conversion (they're not tables) but get stripped
    // character-by-character in Phase 3, leaving behind bare filenames that
    // normalizeRagMarkdown then separates with blank lines.
    //
    // Strategy: detect contiguous blocks of tree lines (lines containing ├
    // or └ or starting with │, optionally with 2-space TUI indent), and
    // convert to a flat markdown list preserving relative indentation.
    //
    // Input:
    //   01_产品模块/TRP/
    //   ├── _MODULE_INDEX.md    # 模块索引
    //   ├── 设计文档/           # 27篇
    //   │   ├── foo.md
    //   │   └── bar.md
    //   └── OCSP/
    //
    // Output:
    //   01_产品模块/TRP/
    //   - _MODULE_INDEX.md    # 模块索引
    //   - 设计文档/           # 27篇
    //     - foo.md
    //     - bar.md
    //   - OCSP/
    //
    // A tree block ends when a non-tree, non-empty line is encountered.
    // The root label line (no tree characters, immediately before tree lines)
    // is kept as-is.
    text = convertTreeBlocks(text);

    // ── Phase 1 & 2 & 3: Line-by-line processing ──────────────────────────

    // Lines matching any of these patterns are noise — remove the whole line.
    const FULL_LINE_NOISE = [
        /^⏺/,                                              // any ⏺ tool-use line
        /^●\s/,                                             // ● tool-use marker line
        /^\s*⎿/,                                            // ⎿ tool result continuation
        /^thought for \d+s\s*$/,                           // standalone "thought for Xs"
        /Type your message or @path\/to\/file/,
        /Press 'i' for INSERT mode/,
        /^\s*⏵⏵\s/,                                        // ⏵⏵ auto-accept status
        /^\s*[✓✗]\s.*(?:Update installed|Restart to apply)/, // update status bar
        /\?\s*for shortcuts/,                               // "? for shortcuts" hint
        /^\s*…\s*\+\d+\s*lines?\s*\(ctrl\+/,              // "… +334 lines (ctrl+o to expand)"
    ];

    // Trailing right-pane status fragments.
    //
    // AgentAPI renders Claude Code's split-pane TUI at fixed column width (80).
    // The right pane shows status text like "esc to interrupt", "thought for Xs)",
    // "↓ 1.8k tokens)" etc. These bleed into the content as trailing text after
    // a gap of whitespace. The status string can be truncated at any column
    // boundary, producing fragments like "interrupt", "rrupt", "rupt", "upt" etc.
    //
    // Strategy: match 4+ trailing spaces (preceded by a non-space character)
    // followed by any text. Normal markdown never has 4+ consecutive mid-line
    // spaces; the TUI padding always produces a wide gap before status text.
    //
    // EXCEPTION: "  # comment" after 4+ spaces is a legitimate inline annotation
    // in directory trees (e.g. "├── foo.md    # description"). Never strip those.
    //
    // Also match exact known phrases after just 2+ spaces for safety.
    const TRAILING_FRAGMENT = /(?<=\S)\s{4,}(?!#\s)\S.*$|\s{2,}(?:esc to interrupt|ctrl\+[a-z] to (?:expand|interrupt)\)?|to expand\)|thought for \d+s\)?|[\d.]+s\s*[·•]\s*thought for \d+s\)|↓[^)]*\)|[\d.]+[ks]?\s*tokens[^)]*\)|\d+\.\d+s\)).*$/;

    // Trailing "thought for Xs" suffix after content.
    // Also catches garbled variants from vt100 rendering:
    //   "Sautéed for 30s", "Crunched for 32s", etc.
    // Pattern: any capitalized word + "for Ns" at end of line.
    const THOUGHT_SUFFIX = /\s*[\u2014\u2013-]\s*thought for \d+s\s*$|\s+thought for \d+s\s*$|\s*[A-Z][a-zéè]+ for \d+s\s*$/;

    // Inline keyboard shortcut hints.
    const INLINE_HINT = /\s*\(ctrl\+[a-z] to (?:expand|interrupt)\)/g;

    // All TUI symbols that may appear inline (after table conversion).
    const TUI_SYMBOLS = /[⎿▀▄░✦●✻⏺⏵❯]/g;

    // Any remaining box-drawing characters not part of a converted table.
    const REMAINING_BOX_DRAWING = /[─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬╭╮╯╰]/g;

    const processed = text
        .split('\n')
        .map(line => {
            // Phase 1: Remove whole-line noise.
            if (FULL_LINE_NOISE.some(re => re.test(line))) return { text: '', wrapped: false };

            // Phase 2b: Detect 80-col line-wrap markers BEFORE stripping them.
            // When Claude's TUI wraps a long prose line at column 80, the right
            // edge may show a run of box-drawing dashes (─) that were part of
            // the TUI border. After stripping those dashes the line is truncated
            // mid-sentence. Mark these lines so Phase 4 can merge them with the
            // continuation line below.
            //
            // Two patterns indicate a wrapped (truncated) line:
            //   a. Line ends with ─ (box-drawing dash) right at the TUI border.
            //      Example: "...Nginx +      ───────────────"
            //   b. Line ends with 10+ trailing spaces — the TUI pads all lines
            //      to exactly 80 columns. Content that ends mid-sentence will be
            //      padded to fill the column. We distinguish these from blank lines
            //      by requiring at least one non-space character on the line.
            //      Example: "  TRP (Trusted Reverse Proxy) 是                    "
            //
            // IMPORTANT: check BEFORE Phase 2 strips TRAILING_FRAGMENT and before
            // trimEnd(), because those operations remove the evidence.
            const hasBoxDrawingTrail = /[─━]+\s*$/.test(line);
            // 10+ trailing spaces on a non-blank line → TUI column padding wrap.
            // EXCEPTION: lines that are list items (- foo), headings (# foo),
            // horizontal rules (---), or table rows are complete entries, not
            // wrapped prose.
            const trimmedLine = line.trimStart();
            const isStructuredLine = /^(?:[-*+]\s|#{1,6}\s|\d+\.\s|[┌├└│]|-{3,}|\*{3,}|_{3,}|\*\*[^*])/.test(trimmedLine);
            const hasPaddingTrail = !isStructuredLine && /\S\s{10,}$/.test(line);
            const wrapped = hasBoxDrawingTrail || hasPaddingTrail;

            // Phase 2: Strip trailing fragments.
            line = line.replace(TRAILING_FRAGMENT, '');

            // Phase 3: Strip remaining TUI symbols and box-drawing chars.
            line = line.replace(TUI_SYMBOLS, '');
            line = line.replace(REMAINING_BOX_DRAWING, '');

            // Phase 3b: Convert bullet symbols to standard markdown list markers.
            // Claude sometimes uses • (U+2022) or other bullet chars for lists.
            // DingTalk markdown only recognizes "- " as unordered list marker.
            line = line.replace(/^(\s*)[•◦‣⁃]\s*/, '$1- ');

            return { text: line.trimEnd(), wrapped };
        })
        // Phase 4a: Merge 80-col wrapped lines with their continuation.
        .reduce((acc, item) => {
            // A wrapped line should be merged with its continuation, UNLESS the
            // continuation is a markdown structural element (list item, heading,
            // HR, code fence). Those are never prose continuations.
            const continuationIsStructured = /^\s*(?:[-*+]\s|#{1,6}\s|\d+\.\s|-{3,}|\*{3,}|_{3,}|```)/.test(item.text);
            if (acc.length > 0 && acc[acc.length - 1].wrapped && item.text !== '' && !continuationIsStructured) {
                const prev = acc[acc.length - 1];
                // Inherit the continuation line's wrapped state: if the merged
                // line is itself truncated, the next line should also be merged.
                acc[acc.length - 1] = { text: prev.text + ' ' + item.text.trimStart(), wrapped: item.wrapped };
            } else {
                acc.push(item);
            }
            return acc;
        }, [])
        .map(item => item.text)
        // Phase 4: Collapse consecutive blank lines to max 1.
        .reduce((acc, line) => {
            if (line === '' && acc.length > 0 && acc[acc.length - 1] === '') {
                return acc;
            }
            return [...acc, line];
        }, []);

    // ── Phase 5: Strip leading whitespace outside code fences ──────────────
    // AgentAPI's TUI panel adds 2-space indentation to content lines.
    // This breaks DingTalk markdown (headings, lists must start at column 0).
    // Preserve indentation inside fenced code blocks.
    // Also preserve lines that are already indented markdown list items
    // (produced by convertTreeBlocks for nested directory entries).
    let inFence = false;
    const deindented = processed.map(line => {
        if (/^```/.test(line.trim())) {
            inFence = !inFence;
            return line.trimStart(); // The fence marker itself should be unindented
        }
        if (inFence) return line; // Preserve code block indentation
        // Preserve intentional indentation on nested list items (e.g. "  - foo")
        // produced by convertTreeBlocks. These start with 2+ spaces followed by "- ".
        if (/^ {2,}- /.test(line)) return line;
        return line.trimStart();
    });

    return deindented.join('\n').trim();
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
 *   - Between consecutive bold-key lines (**key**: value): no blank line
 *     (these are generated by table-to-list conversion for DingTalk)
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

    // Matches bold-key lines produced by convertRowsToBoldList:
    //   - **key**: value          (2-col table rows, list item format)
    //   - **col1** / **col2**     (multi-col table header, list item format)
    //   - val1 / val2             (multi-col table data, list item format)
    // Also matches legacy plain bold-key lines (in case of older cached content).
    const isBoldKeyLine = (l) => /^-\s+\*\*[^*]+\*\*[\s]*[:/]/.test(l) || /^\*\*[^*]+\*\*[\s]*[:/]/.test(l);
    // Matches plain data rows of multi-col tables (e.g. "- val1 / val2 / val3")
    const isSlashSeparatedRow = (l) => /^-\s+[^|*#\-\d].+\s\/\s/.test(l) || /^[^|*#\-\d].+\s\/\s/.test(l);
    // Either type of table-derived line
    const isTableDerivedLine = (l) => isBoldKeyLine(l) || isSlashSeparatedRow(l);

    // Heuristic: detect lines that look like code/commands/JSON.
    // When two adjacent lines both match, skip blank-line injection.
    // This prevents normalizeRagMarkdown from breaking apart code blocks
    // that arrive without fenced code markers (Claude TUI 80-col output).
    const isCodeLike = (l) => {
        // Shell commands
        if (/^(?:curl|wget|docker|git|npm|npx|node|python|pip|go |make|ssh|scp|rsync|tar|cat|echo|export|source|chmod|chown|mkdir|rm|cp|mv|ls|cd|grep|awk|sed)\b/.test(l)) return true;
        // HTTP method lines (e.g. "POST /deploy", "GET /health")
        if (/^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\//.test(l)) return true;
        // Shell comment lines
        if (/^#\s/.test(l)) return true;
        // Line continuation (previous line ended with \)
        if (/^-[A-Za-z]/.test(l)) return true;  // e.g. -H, -d flags
        // JSON-like lines: opening/closing braces, "key": value
        if (/^\s*[{}[\]]/.test(l)) return true;
        if (/^\s*"[^"]+"\s*:/.test(l)) return true;
        // Lines ending with shell continuation backslash
        if (/\\\s*$/.test(l)) return true;
        // Indented content that looks like part of a command/JSON block
        // (4+ space indent after de-TUI with content)
        if (/^\s{2,}(?:[-"]|\w+=|[{}[\]])/.test(l)) return true;
        return false;
    };

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
        // Match both top-level (- foo) and indented list items (  - foo, produced
        // by convertTreeBlocks for nested directory tree entries).
        const isCurrentListItem = /^\s*[-*+]\s|^\s*\d+\.\s/.test(line);
        const isNextListItem = /^\s*[-*+]\s|^\s*\d+\.\s/.test(nextLine);
        const isCurrentEmpty = line === '';

        // Never insert blank lines when current line is empty.
        if (isCurrentEmpty) continue;

        // Between two consecutive list items: no blank line.
        if (isCurrentListItem && isNextListItem) continue;

        // Between consecutive table-derived lines: no blank line.
        if (isTableDerivedLine(line) && isTableDerivedLine(nextLine)) continue;

        // Between consecutive code-like lines: no blank line.
        // This prevents splitting apart multi-line commands/JSON that
        // arrive without code fences from the TUI output.
        if (isCodeLike(line) && isCodeLike(nextLine)) continue;

        // 80-column line-wrap continuation: don't insert blank line when
        // the next line looks like a continuation of the current sentence.
        // Two patterns:
        //   1. Current line ends with +, |, or comma → next starts with
        //      open-paren / lowercase / CJK (connector-based continuation).
        //      Example: "基于 Nginx + OpenResty" / "(Lua) 开发。"
        //   2. Next line starts with "(" — almost always a parenthetical
        //      continuation of the previous line truncated at column 80.
        //      Guard: current line must not end with sentence-ending punctuation
        //      (。！？.!?…) to avoid merging genuinely separate sentences.
        const endsWithConnector = /[+|,]\s*$/.test(line);
        const nextIsContinuation = /^[(\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ffa-z]/.test(nextLine);
        const nextStartsParen = /^\(/.test(nextLine);
        const currentEndsWithSentence = /[。！？.!?…]\s*$/.test(line);
        if (endsWithConnector && nextIsContinuation) continue;
        if (nextStartsParen && !currentEndsWithSentence) continue;

        // Insert blank line after headings.
        if (isCurrentHeading) { result.push(''); continue; }

        // Insert blank line in all other non-empty → non-empty transitions.
        result.push('');
    }

    return result.join('\n');
}

module.exports = { cleanTuiOutput, normalizeRagMarkdown };
