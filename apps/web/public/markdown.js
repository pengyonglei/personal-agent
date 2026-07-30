import DOMPurify from '/vendor/dompurify.js';
import { marked } from '/vendor/marked.js';

marked.setOptions({
  breaks: true,
  gfm: true,
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMarkdown(source) {
  const rendered = marked.parse(source, { async: false });
  return DOMPurify.sanitize(rendered, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['iframe', 'object', 'embed', 'style'],
    USE_PROFILES: { html: true },
  });
}
