import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseDiffContext,
  computeLineDiff,
  toUnifiedDiffText,
} from '../client/src/file-diff';

test('identical texts produce context-only lines with matching line numbers', () => {
  const { lines, truncated } = computeLineDiff('a\nb\nc\n', 'a\nb\nc\n');
  assert.equal(truncated, false);
  assert.deepEqual(
    lines.map((line) => line.kind),
    ['context', 'context', 'context'],
  );
  assert.deepEqual(
    lines.map((line) => [line.oldLineNo, line.newLineNo]),
    [
      [1, 1],
      [2, 2],
      [3, 3],
    ],
  );
});

test('appended lines are add lines with new line numbers', () => {
  const { lines } = computeLineDiff('a\nb\n', 'a\nb\nc\nd\n');
  assert.deepEqual(
    lines.map((line) => [line.kind, line.oldLineNo, line.newLineNo]),
    [
      ['context', 1, 1],
      ['context', 2, 2],
      ['add', undefined, 3],
      ['add', undefined, 4],
    ],
  );
});

test('removed lines keep old line numbers', () => {
  const { lines } = computeLineDiff('a\nb\nc\n', 'a\nc\n');
  assert.deepEqual(
    lines.map((line) => [line.kind, line.oldLineNo, line.newLineNo]),
    [
      ['context', 1, 1],
      ['remove', 2, undefined],
      ['context', 3, 2],
    ],
  );
});

test('replaced line is rendered as remove + add', () => {
  const { lines } = computeLineDiff('old line\n', 'new line\n');
  assert.deepEqual(
    lines.map((line) => [line.kind, line.text]),
    [
      ['remove', 'old line'],
      ['add', 'new line'],
    ],
  );
});

test('empty old text is all adds and empty new text is all removes', () => {
  const added = computeLineDiff('', 'x\ny\n');
  assert.deepEqual(
    added.lines.map((line) => line.kind),
    ['add', 'add'],
  );
  assert.deepEqual(
    added.lines.map((line) => line.newLineNo),
    [1, 2],
  );

  const removed = computeLineDiff('x\ny\n', '');
  assert.deepEqual(
    removed.lines.map((line) => line.kind),
    ['remove', 'remove'],
  );
  assert.deepEqual(
    removed.lines.map((line) => line.oldLineNo),
    [1, 2],
  );
});

test('oversized files are truncated and flagged', () => {
  const bigOld = Array.from({ length: 20 }, (_, i) => `old-${i}`).join('\n');
  const bigNew = Array.from({ length: 20 }, (_, i) => `new-${i}`).join('\n');
  const { lines, truncated } = computeLineDiff(bigOld, bigNew, 5);
  assert.equal(truncated, true);
  // 每侧只计算前 5 行
  assert.equal(lines.filter((line) => line.kind === 'remove').length, 5);
  assert.equal(lines.filter((line) => line.kind === 'add').length, 5);
});

test('toUnifiedDiffText produces git-style headers and +/- prefixes', () => {
  const diff = toUnifiedDiffText('src/app.ts', 'a\n', 'a\nb\n');
  assert.match(diff, /^--- a\/src\/app\.ts/m);
  assert.match(diff, /^\+\+\+ b\/src\/app\.ts/m);
  assert.match(diff, /^@@ -1,1 \+1,2 @@$/m);
  assert.match(diff, /^ a$/m);
  assert.match(diff, /^\+b$/m);
});

test('collapseDiffContext keeps hunks with a few context lines and folds large unchanged runs', () => {
  // 100 行文件，只有第 50 行被修改：首尾大段未修改内容应折叠为省略行
  const oldLines = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`);
  const newLines = [...oldLines];
  newLines[49] = 'line-50-modified';
  const { lines } = computeLineDiff(oldLines.join('\n'), newLines.join('\n'));
  const display = collapseDiffContext(lines);

  assert.ok(display.some((line) => line.kind === 'gap'), '大段未修改内容应折叠为省略行');
  const gaps = display.filter((line) => line.kind === 'gap');
  // 修改块（remove+add，第 50 行）前后各有 3 行上下文，首尾各有一段折叠
  assert.equal(gaps.length, 2);
  const skippedTotal = gaps.reduce((sum, gap) => sum + gap.skipped, 0);
  // 保留：2 个修改行 + 2×3 行上下文 = 8 行
  assert.equal(skippedTotal, lines.length - 8);
  // 保留行包含修改行及前后 3 行上下文
  const keptTexts = display
    .filter((line) => line.kind !== 'gap')
    .map((line) => line.text);
  assert.ok(keptTexts.includes('line-50-modified'));
  assert.ok(keptTexts.includes('line-47'));
  assert.ok(keptTexts.includes('line-53'));
  assert.ok(!keptTexts.includes('line-1'));
  assert.ok(!keptTexts.includes('line-100'));
});

test('collapseDiffContext does not fold between hunks closer than 2×context lines', () => {
  // 两处修改相距 4 行（中间 3 行上下文）：全部保留，无省略行
  const oldLines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
  const newLines = [...oldLines];
  newLines[1] = 'line-2-modified';
  newLines[6] = 'line-7-modified';
  const { lines } = computeLineDiff(oldLines.join('\n'), newLines.join('\n'));
  const display = collapseDiffContext(lines);
  assert.ok(!display.some((line) => line.kind === 'gap'), '相邻修改块之间不应产生省略行');
  assert.equal(display.length, lines.length);
});

test('collapseDiffContext returns unchanged lines when nothing changed', () => {
  const { lines } = computeLineDiff('a\nb\nc\n', 'a\nb\nc\n');
  assert.deepEqual(collapseDiffContext(lines), lines);
});

test('collapseDiffContext leaves all-add / all-remove diffs untouched', () => {
  const added = computeLineDiff('', 'x\ny\nz\n');
  assert.deepEqual(collapseDiffContext(added.lines), added.lines);

  const removed = computeLineDiff('x\ny\nz\n', '');
  assert.deepEqual(collapseDiffContext(removed.lines), removed.lines);
});

test('collapseDiffContext folds leading and trailing unchanged runs separately', () => {
  // 文件开头 5 行未变 + 修改 + 结尾 5 行未变：修改行前后各保留 1 行上下文
  const oldLines = Array.from({ length: 11 }, (_, i) => `line-${i + 1}`);
  const newLines = [...oldLines];
  newLines[5] = 'line-6-modified';
  const { lines } = computeLineDiff(oldLines.join('\n'), newLines.join('\n'));
  const display = collapseDiffContext(lines, 1);
  const gaps = display.filter((line) => line.kind === 'gap');
  assert.equal(gaps.length, 2);
  // 保留 2 个修改行 + 2×1 上下文 = 4 行，其余 8 行折叠
  assert.equal(
    gaps.reduce((sum, gap) => sum + gap.skipped, 0),
    lines.length - 4,
  );
});
