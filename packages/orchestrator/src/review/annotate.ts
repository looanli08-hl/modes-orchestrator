/*
 * Vendored from Orca (https://github.com/stablyai/orca)
 * src/shared/diff-comments-format.ts @ 438603f9e723ae0e16bbd34d3f0d932b417790df
 *
 * MIT License
 *
 * Copyright (c) 2026 Lovecast Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Local adaptation: DiffComment is narrowed to AnnotateComment — only the
 * fields the formatter reads. The formatting logic is unchanged.
 */

/** a review note pinned to a diff line; lineNumber 0 means file scope */
export interface AnnotateComment {
  filePath: string;
  lineNumber: number;
  /** inclusive range start; must be <= lineNumber when present */
  startLine?: number;
  body: string;
  /** 'diff' notes anchor on diff lines; 'markdown' notes quote prose */
  source?: 'diff' | 'markdown';
}

function isMarkdownComment(comment: Pick<AnnotateComment, 'source'>): boolean {
  return comment.source === 'markdown';
}

// Why: the pasted format is the contract between review notes and whichever
// agent consumes them. Keep it deterministic and quote-safe across clients.
export function formatDiffComment(c: AnnotateComment): string {
  const escaped = c.body
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  const locationLabel =
    c.lineNumber === 0
      ? 'Scope: file'
      : c.startLine !== undefined && c.startLine !== c.lineNumber
        ? `Lines: ${c.startLine}-${c.lineNumber}`
        : `Line: ${c.lineNumber}`;
  if (!isMarkdownComment(c)) {
    return [`File: ${c.filePath}`, locationLabel, `User comment: "${escaped}"`].join('\n');
  }
  return [
    `File: ${c.filePath}`,
    'Source: markdown',
    locationLabel,
    `User comment: "${escaped}"`
  ].join('\n');
}

export function formatDiffComments(comments: readonly AnnotateComment[]): string {
  return comments.map(formatDiffComment).join('\n\n');
}
