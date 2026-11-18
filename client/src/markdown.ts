/** Just enough Markdown for the post-game reveal: headings, lists, tables, bold, italics. */
export function renderMarkdown(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])_(.+?)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  const out: string[] = [];
  let list = 0; // current list depth
  let table: string[][] | null = null;
  const closeList = () => {
    while (list > 0) {
      out.push('</ul>');
      list--;
    }
  };
  const closeTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    out.push('<table><thead><tr>', ...head.map((c) => `<th>${inline(c)}</th>`), '</tr></thead><tbody>');
    for (const r of rows) out.push('<tr>', ...r.map((c) => `<td>${inline(c)}</td>`), '</tr>');
    out.push('</tbody></table>');
    table = null;
  };

  for (const line of md.split('\n')) {
    const cells = /^\|(.+)\|\s*$/.exec(line);
    if (cells) {
      closeList();
      const row = cells[1].split('|').map((c) => c.trim());
      if (row.every((c) => /^-+$/.test(c))) continue;
      (table ??= []).push(row);
      continue;
    }
    closeTable();
    const item = /^(\s*)- (.*)$/.exec(line);
    if (item) {
      const depth = Math.floor(item[1].length / 2) + 1;
      while (list < depth) {
        out.push('<ul>');
        list++;
      }
      while (list > depth) {
        out.push('</ul>');
        list--;
      }
      out.push(`<li>${inline(item[2])}</li>`);
      continue;
    }
    closeList();
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) out.push(`<h${heading[1].length + 1}>${inline(heading[2])}</h${heading[1].length + 1}>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeTable();
  closeList();
  return out.join('');
}
