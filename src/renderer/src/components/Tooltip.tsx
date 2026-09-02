/**
 * Themed hover-tooltip that replaces the slow OS-native `title` attr.
 *
 * Usage:
 *   <Tooltip text="Detach panel"><button>↗</button></Tooltip>
 *
 * - Single child required (the trigger).
 * - Tooltip is positioned above the child, centered horizontally;
 *   flips below if there's not enough room above.
 * - 200ms show delay, instant hide on leave.
 * - Pointer-events: none so it never interferes with the trigger.
 */

import { cloneElement, isValidElement, ReactElement, ReactNode, useEffect, useRef, useState } from 'react';

interface Props {
  text: string;
  children: ReactElement;
  /** Optional: extra className / placement override. */
  side?: 'top' | 'bottom';
}

export function Tooltip({ text, children, side = 'top' }: Props) {
  const [visible, setVisible] = useState(false);
  const [flip, setFlip] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (!isValidElement(children)) return children;

  const trigger = children as ReactElement<{
    onMouseEnter?: (e: React.MouseEvent) => void;
    onMouseLeave?: (e: React.MouseEvent) => void;
    onFocus?: (e: React.FocusEvent) => void;
    onBlur?: (e: React.FocusEvent) => void;
    title?: string;
  }>;
  const childProps = trigger.props ?? {};
  // Decide flip on first show: if we're too close to the top, flip below.
  const onEnter = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (wrapRef.current) {
        const r = wrapRef.current.getBoundingClientRect();
        setFlip(side === 'top' ? r.top < 36 : false);
      }
      setVisible(true);
    }, 200);
  };
  const onLeave = () => {
    if (timer.current) clearTimeout(timer.current);
    setVisible(false);
  };

  // Inject the hover listeners + a ref onto the child via cloneElement.
  // We deliberately do NOT replace the child — only augment it.
  const triggerProps = {
    onMouseEnter: (e: React.MouseEvent) => {
      onEnter();
      childProps.onMouseEnter?.(e);
    },
    onMouseLeave: (e: React.MouseEvent) => {
      onLeave();
      childProps.onMouseLeave?.(e);
    },
    onFocus: (e: React.FocusEvent) => {
      onEnter();
      childProps.onFocus?.(e);
    },
    onBlur: (e: React.FocusEvent) => {
      onLeave();
      childProps.onBlur?.(e);
    },
    // Keep the native title as a fallback for screen-readers / very
    // long press — it won't normally show because our tooltip wins.
    title: text,
  };

  return (
    <span ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      {cloneElement(trigger, triggerProps)}
      {visible && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            ...(flip || side === 'bottom'
              ? { top: 'calc(100% + 6px)' }
              : { bottom: 'calc(100% + 6px)' }),
            background: 'var(--bg-elev)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '3px 8px',
            fontSize: 11,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            boxShadow: '0 4px 12px var(--shadow)',
            zIndex: 3000,
            // Tiny fade so it doesn't pop visually.
            animation: 'tip-fade-in 80ms ease-out',
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

/**
 * Helper for tooltip wrappers around raw DOM-style children that don't
 * accept arbitrary props. Returns a `<span>` with the tooltip wired up.
 * Prefer `<Tooltip>` directly whenever possible — this is the fallback
 * for icon spans we can't easily cloneElement.
 */
export function TooltipSpan({ text, children, onClick, style, disabled, ...rest }: {
  text: string;
  children: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
  disabled?: boolean;
}) {
  return (
    <Tooltip text={text}>
      <button
        onClick={onClick}
        disabled={disabled}
        style={{
          ...style,
          cursor: disabled ? 'not-allowed' : (style?.cursor ?? 'pointer'),
          opacity: disabled ? 0.5 : (style?.opacity ?? 1),
        }}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
}
