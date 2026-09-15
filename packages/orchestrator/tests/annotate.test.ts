/**
 * Unit test: the vendored Orca diff-comment formatter (src/review/annotate.ts).
 * The line-anchored text format is the contract between panel notes and the
 * agent that receives them — pin it exactly.
 */

import { describe, expect, it } from 'vitest';

import { formatDiffComment, formatDiffComments } from '../src/review/annotate';

describe('formatDiffComment', () => {
  it('anchors a note to a file and line', () => {
    expect(formatDiffComment({ filePath: 'src/a.ts', lineNumber: 42, body: 'rename this' })).toBe(
      'File: src/a.ts\nLine: 42\nUser comment: "rename this"'
    );
  });

  it('lineNumber 0 means file scope', () => {
    expect(formatDiffComment({ filePath: 'README.md', lineNumber: 0, body: 'whole file feels off' })).toBe(
      'File: README.md\nScope: file\nUser comment: "whole file feels off"'
    );
  });

  it('renders a line range when startLine differs', () => {
    expect(formatDiffComment({ filePath: 'src/a.ts', startLine: 10, lineNumber: 14, body: 'extract this' })).toBe(
      'File: src/a.ts\nLines: 10-14\nUser comment: "extract this"'
    );
  });

  it('startLine equal to lineNumber collapses to a single line', () => {
    expect(formatDiffComment({ filePath: 'src/a.ts', startLine: 7, lineNumber: 7, body: 'x' })).toContain('Line: 7');
  });

  it('escapes quotes, backslashes and newlines in the body', () => {
    expect(formatDiffComment({ filePath: 'f', lineNumber: 1, body: 'say "hi" \\ twice\nhere' })).toBe(
      'File: f\nLine: 1\nUser comment: "say \\"hi\\" \\\\ twice\\nhere"'
    );
  });

  it('markdown notes carry their source', () => {
    expect(formatDiffComment({ filePath: 'doc.md', lineNumber: 3, body: 'trim', source: 'markdown' })).toBe(
      'File: doc.md\nSource: markdown\nLine: 3\nUser comment: "trim"'
    );
  });
});

describe('formatDiffComments', () => {
  it('joins multiple notes across files with a blank line', () => {
    const out = formatDiffComments([
      { filePath: 'a.ts', lineNumber: 1, body: 'first' },
      { filePath: 'b.ts', lineNumber: 9, body: 'second' },
      { filePath: 'b.ts', lineNumber: 20, body: 'third' },
    ]);
    expect(out).toBe(
      'File: a.ts\nLine: 1\nUser comment: "first"\n\n' +
        'File: b.ts\nLine: 9\nUser comment: "second"\n\n' +
        'File: b.ts\nLine: 20\nUser comment: "third"'
    );
  });
});
