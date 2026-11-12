// The themes' colours: the fields a theme sets, the built-in themes, and
// the arithmetic a custom one is derived by (a colour's contrast pole, the
// state colours).

// -----------------------------------------------------------------------
// ---- theme ----
// A theme is the four base colors; --mid/--high/--contrast derive from
// them (see :root). applyColors() writes the bases onto :root inline and
// picks --contrast from background luminance so emphasis works on both
// dark and light backgrounds. Selection is persisted to localStorage.
// -----------------------------------------------------------------------
export const THEME_FIELDS = [
  ['background', 'Background'],
  ['foreground', 'Foreground'],
  ['accent', 'Accent'],
  ['error', 'Error'],
];
export const THEMES = {
  default:  { name: 'Default',  background: '#000', foreground: '#7df', accent: '#6c9', error: '#f33' },
  blue:   { name: 'Blue',   background: '#00c', foreground: '#eee', accent: '#0f0', error: '#f33' },
  light: { name: 'Light', background: '#fff', foreground: '#00f', accent: '#f00', error: '#f00' },
};

export const DEFAULT_THEME_ID = 'default';

export function parseHexRGB(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function toHex6(hex) {
  const c = parseHexRGB(hex);
  return c ? '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('') : '#000000';
}
// WCAG relative luminance → emphasis pole (white on dark, black on light).
export function contrastPole(bg) {
  const c = parseHexRGB(bg) || { r: 0, g: 0, b: 0 };
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  return lum > 0.4 ? '#000' : '#fff';
}
export function colorsForState(st) {
  return st.id === 'custom' ? st.custom : (THEMES[st.id] || THEMES[DEFAULT_THEME_ID]);
}
