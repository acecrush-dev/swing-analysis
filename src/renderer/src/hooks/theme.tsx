import { createContext, ReactNode, useContext, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

interface ThemeCtxValue {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}

const ThemeCtx = createContext<ThemeCtxValue>({
  theme: 'dark',
  toggle: () => {},
  setTheme: () => {},
});

// CSS variables applied to <html> via JS (so inline `var(--name)`
// styles in components pick them up automatically).
const DARK: Record<string, string> = {
  '--bg': '#1a1a1a',
  '--bg-alt': '#161616',
  '--bg-elev': '#222',
  '--bg-elev2': '#0e0e0e',
  '--text': '#eee',
  '--text-muted': '#aaa',
  '--text-dim': '#777',
  '--border': '#333',
  '--border-soft': '#222',
  '--accent': '#ffeb3b',
  '--accent-fg': '#000',
  '--danger': '#f88',
  '--danger-bg': '#532',
  '--danger-border': '#a44',
  '--success': '#4a9',
  '--warn': '#fa3',
  '--link': '#4af',
  '--shadow': 'rgba(0,0,0,0.4)',
  // Job-state badge pairs (bg + contrasting fg) — chosen so each is
  // legible in both themes. Dark uses the existing vibrant tones; light
  // dials them down so they read on a near-white bg.
  '--state-idle-bg': '#444',     '--state-idle-fg': '#ddd',
  '--state-queued-bg': '#446',   '--state-queued-fg': '#fff',
  '--state-running-bg': '#4a9',  '--state-running-fg': '#fff',
  '--state-done-bg': '#4a9',     '--state-done-fg': '#fff',
  '--state-failed-bg': '#a44',   '--state-failed-fg': '#fff',
  '--state-cancelled-bg': '#666','--state-cancelled-fg': '#ddd',
};

const LIGHT: Record<string, string> = {
  '--bg': '#f5f5f5',
  '--bg-alt': '#ffffff',
  '--bg-elev': '#fafafa',
  '--bg-elev2': '#eeeeee',
  '--text': '#1a1a1a',
  '--text-muted': '#666',
  '--text-dim': '#999',
  '--border': '#ddd',
  '--border-soft': '#eee',
  '--accent': '#f90',
  '--accent-fg': '#000',
  '--danger': '#c33',
  '--danger-bg': '#fee',
  '--danger-border': '#c99',
  '--success': '#3a7',
  '--warn': '#e80',
  '--link': '#06c',
  '--shadow': 'rgba(0,0,0,0.1)',
  '--state-idle-bg': '#d0d0d0',     '--state-idle-fg': '#333',
  '--state-queued-bg': '#5a78c9',   '--state-queued-fg': '#fff',
  '--state-running-bg': '#3a7',     '--state-running-fg': '#fff',
  '--state-done-bg': '#3a7',        '--state-done-fg': '#fff',
  '--state-failed-bg': '#c33',      '--state-failed-fg': '#fff',
  '--state-cancelled-bg': '#b5b5b5','--state-cancelled-fg': '#333',
};

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const vars = theme === 'dark' ? DARK : LIGHT;
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
  root.dataset.theme = theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('dark');
  useEffect(() => { applyTheme(theme); }, [theme]);
  const value: ThemeCtxValue = {
    theme,
    setTheme: setThemeState,
    toggle: () => setThemeState((t) => (t === 'dark' ? 'light' : 'dark')),
  };
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  return useContext(ThemeCtx);
}