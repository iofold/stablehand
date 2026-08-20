import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Message } from '@/stores/conversation';
import { MessageBubble } from './MessageBubble';

function assistantMessage(content: string): Message {
  return {
    id: 'message-1',
    messageRevision: 0,
    role: 'assistant',
    content,
    createdAt: 1_787_182_628_068,
  };
}

describe('MessageBubble', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderMessage(content: string): void {
    act(() => {
      root.render(<MessageBubble message={assistantMessage(content)} />);
    });
  }

  it('renders multiline NDJSON literally without Markdown formatting', () => {
    const content = [
      '{"type":"extract","v":"Decking ~170 SF"}',
      '{"type":"extract","v":"Alleges ~$34,680 shortfall"}',
      '{"type":"analysis","html":"Documented shortfall is ~$34,680"}',
      '{"type":"done"}',
    ].join('\n');

    renderMessage(content);

    const output = container.querySelector('[data-testid="assistant-ndjson-output"]');
    expect(output?.textContent).toBe(content);
    expect(output?.tagName).toBe('PRE');
    expect(output?.classList.contains('whitespace-pre-wrap')).toBe(true);
    expect(output?.classList.contains('break-words')).toBe(true);
    expect(container.querySelector('del')).toBeNull();
  });

  it('keeps single approximation tildes literal while preserving explicit GFM strikethrough', () => {
    renderMessage([
      'Alleges ~$34,680 shortfall',
      'close>~$34,680 documented',
      'Intentional ~~removed~~.',
    ].join('\n'));

    expect(container.textContent).toContain('~$34,680');
    const deletions = container.querySelectorAll('del');
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.textContent).toBe('removed');
  });

  it('renders allowed HTML-only replies and removes unsafe markup', () => {
    renderMessage(
      '<p>The <strong>yellow items</strong> need <span class="hi">review</span>.</p>' +
      '<script>window.compromised = true</script>' +
      '<img src="x" onerror="window.compromised = true">',
    );

    expect(container.querySelector('strong')?.textContent).toBe('yellow items');
    expect(container.querySelector('span.hi')?.textContent).toBe('review');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.textContent).not.toContain('window.compromised');
  });
});
