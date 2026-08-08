/** 行级 diff 的行类型。 */
export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  /** 旧文件行号（context/remove 行有值）。 */
  oldLineNo?: number;
  /** 新文件行号（context/add 行有值）。 */
  newLineNo?: number;
  text: string;
}

/** 折叠后代替一段连续未修改行的省略行。 */
export interface DiffGap {
  kind: 'gap';
  /** 被省略的未修改行数。 */
  skipped: number;
}

/** 折叠上下文后的展示行（DiffLine 或省略行）。 */
export type DisplayDiffLine = DiffLine | DiffGap;

export interface LineDiffResult {
  lines: DiffLine[];
  /** 任一文件超过行数上限，diff 只覆盖前 MAX_DIFF_LINES 行。 */
  truncated: boolean;
}

/** 参与 diff 计算的单侧最大行数（LCS 内存/耗时保护）。 */
export const MAX_DIFF_LINES = 2000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 计算两个文本的行级 diff（LCS 动态规划），返回带行号的增删上下文序列。
 * 任一文件超过 maxLines 时只对前 maxLines 行计算并标记 truncated。
 */
export function computeLineDiff(
  oldText: string,
  newText: string,
  maxLines: number = MAX_DIFF_LINES,
): LineDiffResult {
  const fullOld = splitLines(oldText);
  const fullNew = splitLines(newText);
  const truncated = fullOld.length > maxLines || fullNew.length > maxLines;
  const a = truncated ? fullOld.slice(0, maxLines) : fullOld;
  const b = truncated ? fullNew.slice(0, maxLines) : fullNew;

  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // dp[i * width + j] = LCS 长度（a[0..i-1] × b[0..j-1]）
  const dp = new Uint16Array((n + 1) * width);
  for (let i = 1; i <= n; i += 1) {
    const row = i * width;
    const prevRow = (i - 1) * width;
    const ai = a[i - 1];
    for (let j = 1; j <= m; j += 1) {
      dp[row + j] =
        ai === b[j - 1]
          ? dp[prevRow + j - 1] + 1
          : Math.max(dp[prevRow + j], dp[row + j - 1]);
    }
  }

  // 回溯生成 diff 序列（逆序收集后反转）
  const reversed: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      reversed.push({ kind: 'context', oldLineNo: i, newLineNo: j, text: a[i - 1] });
      i -= 1;
      j -= 1;
    } else if (dp[(i - 1) * width + j] > dp[i * width + j - 1]) {
      reversed.push({ kind: 'remove', oldLineNo: i, text: a[i - 1] });
      i -= 1;
    } else {
      reversed.push({ kind: 'add', newLineNo: j, text: b[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    reversed.push({ kind: 'remove', oldLineNo: i, text: a[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    reversed.push({ kind: 'add', newLineNo: j, text: b[j - 1] });
    j -= 1;
  }
  reversed.reverse();

  return { lines: reversed, truncated };
}

/**
 * 折叠连续未修改的上下文（git hunk 风格）：每个修改块（add/remove 连续区域）
 * 前后各保留 contextLines 行，其余大段未修改行折叠为省略行（DiffGap）。
 * 无任何修改时原样返回。
 */
export function collapseDiffContext(
  lines: DiffLine[],
  contextLines = 3,
): DisplayDiffLine[] {
  if (lines.length === 0) return [];
  const changed = lines.map((line) => line.kind !== 'context');
  let firstChanged = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (changed[i]) {
      firstChanged = i;
      break;
    }
  }
  if (firstChanged < 0) return [...lines];

  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += 1) {
    if (!changed[i]) continue;
    keep[i] = true;
    for (let k = 1; k <= contextLines; k += 1) {
      if (i - k >= 0 && !changed[i - k]) keep[i - k] = true;
      if (i + k < lines.length && !changed[i + k]) keep[i + k] = true;
    }
  }

  const out: DisplayDiffLine[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (keep[i]) {
      if (skipped > 0) {
        out.push({ kind: 'gap', skipped });
        skipped = 0;
      }
      out.push(lines[i]);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) out.push({ kind: 'gap', skipped });
  return out;
}

/** 生成 git 风格 unified diff 文本（供复制/导出；单 hunk 覆盖全部差异）。 */
export function toUnifiedDiffText(
  path: string,
  oldText: string,
  newText: string,
  maxLines: number = MAX_DIFF_LINES,
): string {
  const { lines, truncated } = computeLineDiff(oldText, newText, maxLines);
  const oldCount = lines.filter((line) => line.kind !== 'add').length;
  const newCount = lines.filter((line) => line.kind !== 'remove').length;
  const out: string[] = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
  ];
  for (const line of lines) {
    out.push(`${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`);
  }
  if (truncated) out.push(`\n（文件超过 ${maxLines} 行，仅展示前 ${maxLines} 行）`);
  return out.join('\n');
}
