// Theme registry. `dark` controls the few brightness-dependent bits (loading dots,
// the html.dark class) that aren't driven by CSS variables. `swatch` is the dot shown
// in the picker. CSS variable values live in index.css under [data-theme="<id>"].

export const THEMES = [
  { id: 'light', name: 'Light', swatch: '#ffffff', dark: false },
  { id: 'dark', name: 'Dark', swatch: '#1f2937', dark: true },
  { id: 'yellow', name: 'Matte Yellow', swatch: '#e6d29a', dark: false },
  { id: 'ocean', name: 'Ocean', swatch: '#16273d', dark: true },
  { id: 'rose', name: 'Rose', swatch: '#f6c5d1', dark: false },
]

export const isDarkTheme = (id) => (THEMES.find((t) => t.id === id) || {}).dark || false
