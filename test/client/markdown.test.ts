import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../client/src/markdown';

describe('renderMarkdown (post-game reveal)', () => {
  it('renders headings, nested lists, bold and italics', () => {
    const html = renderMarkdown('# Game 1\n\n- **Vex** said hi\n  - _thinks: hmm_\n- done');
    expect(html).toBe('<h2>Game 1</h2><ul><li><strong>Vex</strong> said hi</li><ul><li><em>thinks: hmm</em></li></ul><li>done</li></ul>');
  });

  it('renders tables and escapes HTML in AI text', () => {
    const html = renderMarkdown('| Player | Role |\n|---|---|\n| Mo <b> | crew |');
    expect(html).toContain('<th>Player</th>');
    expect(html).toContain('<td>Mo &lt;b&gt;</td>');
    expect(html).not.toContain('<b>');
  });
});
