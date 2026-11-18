/** Player colour names (from the server) to screen colours. */
const PALETTE: Record<string, string> = {
  teal: '#2bb3a3',
  pink: '#ff79b0',
  purple: '#a37bff',
  red: '#ff5252',
  blue: '#4d8dff',
  yellow: '#ffd84d',
  white: '#eef2f5',
  green: '#3ccf6e',
  lime: '#b6f24d',
  orange: '#ff9a3d',
  brown: '#b07a4f',
  grey: '#9aa3ad',
  cyan: '#3de0ff',
};

export function hex(color: string): string {
  return PALETTE[color] ?? '#9aa3ad';
}
