/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 版本号唯一来源（Single Source of Truth）
 *
 * 修改版本时只需要更新这里的 VERSION，然后同步各 package.json 的 version
 * 字段即可。所有 CLI / TUI / Web / MCP / 工具代码均从此处导入。
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** 版本号（不带 v 前缀），例如 '0.1.5' */
export const VERSION = '0.2.14';

/** 展示用版本标签（带 v 前缀），例如 'v0.1.5' */
export const VERSION_LABEL = `v${VERSION}`;

/** User-Agent 等场景使用的完整标识，例如 'personal-agent/0.1.5' */
export const USER_AGENT = `personal-agent/${VERSION}`;
