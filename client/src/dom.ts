/** Tiny element builder: el('div', { class: 'x' }, 'text', child). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') node.addEventListener(k.replace(/^on/, ''), v);
    else if (typeof v === 'boolean') {
      if (v) node.setAttribute(k, '');
    } else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

/** Children list with the optional (null/false) entries dropped, for replaceChildren(). */
export function kids(...items: (Node | string | null | undefined | false)[]): (Node | string)[] {
  return items.filter((c): c is Node | string => !!c);
}

export function show(node: HTMLElement, visible: boolean): void {
  node.classList.toggle('hidden', !visible);
}
