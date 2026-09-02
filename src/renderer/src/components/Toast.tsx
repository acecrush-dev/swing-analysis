/**
 * Toast notification system.
 *
 * - Stack at the top-center of the viewport, just under the title row.
 * - Auto-dismiss after `duration` ms (default 3000).
 * - Supports four kinds: info / success / warning / error. The colour
 *   comes from CSS vars so it tracks the active theme automatically.
 * - Global state lives in module scope so any component can call
 *   `toast(...)` without having to thread a context through.
 *
 * Mount `<ToastHost />` once at the top of the tree (App.tsx and each
 * panel window's root).
 */

import { useEffect, useState } from 'react';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
  duration: number;
}

let nextId = 1;
const listeners = new Set<(items: ToastItem[]) => void>();
let items: ToastItem[] = [];

function emit() {
  for (const l of listeners) l(items.slice());
}

function push(text: string, kind: ToastKind = 'info', duration = 3000): void {
  const id = nextId++;
  items = [...items, { id, text, kind, duration }];
  emit();
  setTimeout(() => {
    items = items.filter((it) => it.id !== id);
    emit();
  }, duration);
}

export const toast = {
  info: (text: string, duration?: number) => push(text, 'info', duration),
  success: (text: string, duration?: number) => push(text, 'success', duration),
  warning: (text: string, duration?: number) => push(text, 'warning', duration),
  error: (text: string, duration?: number) => push(text, 'error', duration),
  dismiss: (id: number) => {
    items = items.filter((it) => it.id !== id);
    emit();
  },
};

const KIND_COLOR: Record<ToastKind, { bg: string; fg: string; border: string; icon: string }> = {
  info:    { bg: 'var(--bg-elev)',  fg: 'var(--text)',         border: 'var(--border)',         icon: 'ℹ️' },
  success: { bg: '#153',            fg: 'var(--success)',       border: 'var(--success)',        icon: '✓' },
  warning: { bg: 'var(--warn)',     fg: 'var(--accent-fg)',     border: 'var(--warn)',           icon: '⚠' },
  error:   { bg: 'var(--danger-bg)',fg: 'var(--danger)',        border: 'var(--danger-border)',  icon: '✗' },
};

export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>(items);

  useEffect(() => {
    const cb = (next: ToastItem[]) => setList(next);
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  }, []);

  if (list.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 56, // sits just under the title row (~h2 24px + padding 16+)
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        zIndex: 4000,
        pointerEvents: 'none',
      }}
    >
      {list.map((it) => {
        const c = KIND_COLOR[it.kind];
        return (
          <div
            key={it.id}
            onClick={() => toast.dismiss(it.id)}
            style={{
              background: c.bg,
              color: c.fg,
              border: `1px solid ${c.border}`,
              borderRadius: 6,
              padding: '8px 14px',
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              boxShadow: '0 8px 24px var(--shadow)',
              pointerEvents: 'auto',
              animation: 'toast-slide-in 180ms ease-out',
              minWidth: 200,
              maxWidth: 480,
            }}
          >
            <span style={{ fontSize: 14, lineHeight: 1 }}>{c.icon}</span>
            <span style={{ flex: 1, lineHeight: 1.45 }}>{it.text}</span>
          </div>
        );
      })}
    </div>
  );
}
