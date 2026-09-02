/**
 * Shared event-log list used by both the docked ResultsPanel and the
 * detached LogPanelApp. Visual styling is preserved verbatim from the
 * previous inline version in ResultsPanel — when `autoScroll` is on
 * (panel side only) we keep the list pinned to the latest entry so
 * the user sees new events without having to scroll manually.
 */

import { useEffect, useRef } from 'react';

interface Props {
  logLines: string[];
  /** Default false; the detached log panel sets this so it tails live. */
  autoScroll?: boolean;
}

export function EventLogList({ logLines, autoScroll = false }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    const el = scrollRef.current;
    // Scroll to bottom on every new line. Cheap because the DOM is
    // bounded (App.tsx caps logLines at 500 entries).
    el.scrollTop = el.scrollHeight;
  }, [logLines, autoScroll]);

  return (
    <div
      ref={scrollRef}
      style={{
        flex: 1, overflow: 'auto', fontSize: 11,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        background: 'var(--bg-elev2)', border: '1px solid var(--border-soft)',
        borderRadius: 4, padding: 8, lineHeight: 1.5, color: 'var(--text)',
      }}
    >
      {logLines.length === 0 ? (
        <div style={{ opacity: 0.5 }}>（暂无事件）</div>
      ) : (
        logLines.map((line, i) => (
          <div key={i} style={{ whiteSpace: 'pre-wrap', opacity: i < logLines.length - 20 ? 0.6 : 1 }}>
            {line}
          </div>
        ))
      )}
    </div>
  );
}
