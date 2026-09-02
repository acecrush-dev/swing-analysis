import { useEffect, useRef, useState } from 'react';
import type { ClipInfo, Segment } from '../api/types';
import { ClipGrid } from './ClipGrid';

interface Props {
  clips: ClipInfo[];
  segments: Segment[];
  activeClip: ClipInfo | null;
  onSelectClip: (c: ClipInfo) => void;
  onCleanupClips: () => void;
  thumbUrl: (segId: number) => string;
  jobDone: boolean;
  saveClipsEnabled: boolean;
}

type DockMode = 'docked' | 'floating';

/**
 * Single-row clips bar.
 *
 * - Default (docked): renders inline below the 开始切分 button in the
 *   left column. Single horizontal row; overflow scrolls horizontally.
 * - Floating: a draggable overlay positioned absolutely above the UI.
 *   User can drag by the header; toggle button in the header switches
 *   back to docked.
 */
export function ClipsBar({
  clips,
  segments: segs,
  activeClip,
  onSelectClip,
  onCleanupClips,
  thumbUrl,
  jobDone,
  saveClipsEnabled,
}: Props) {
  const [mode, setMode] = useState<DockMode>('docked');
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 24, y: 24 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const hasClips = clips.length > 0;
  // Always render — even when no clips yet — so the user can always
  // see where the bar lives and what its empty state means.

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
    cursor: mode === 'floating' ? 'move' : 'default',
    userSelect: 'none',
  };

  const bodyStyle: React.CSSProperties = {
    background: '#161616',
    padding: '8px 12px 10px 12px',
    borderTop: '1px solid #333',
    borderRadius: mode === 'floating' ? 8 : 0,
    boxShadow: mode === 'floating' ? '0 8px 24px rgba(0,0,0,0.5)' : 'none',
  };

  const headerActions = (
    <>
      {hasClips && (
        <button
          onClick={(e) => { e.stopPropagation(); onCleanupClips(); }}
          style={{
            background: '#532',
            color: '#fff',
            border: '1px solid #a44',
            borderRadius: 3,
            padding: '2px 8px',
            cursor: 'pointer',
            fontSize: 11,
            marginRight: 6,
          }}
          title="删除该 job 的全部 clips"
        >
          🧹 清理
        </button>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); setMode(mode === 'docked' ? 'floating' : 'docked'); }}
        style={{
          background: '#222',
          color: '#fff',
          border: '1px solid #444',
          borderRadius: 3,
          padding: '2px 8px',
          cursor: 'pointer',
          fontSize: 11,
        }}
        title={mode === 'docked' ? '悬浮显示（可拖动）' : '停靠回原位'}
      >
        {mode === 'docked' ? '📌 悬浮' : '📍 停靠'}
      </button>
    </>
  );

  const headerEl = (
    <div style={headerStyle} onMouseDown={(e) => {
      // Only start drag in floating mode; left button only.
      if (mode !== 'floating') return;
      if (e.button !== 0) return;
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: pos.x,
        origY: pos.y,
      };
      e.preventDefault();
    }}>
      <h3 style={{ margin: 0, fontSize: 13 }}>
        🎬 Clips {hasClips && <span style={{ opacity: 0.6 }}>({clips.length})</span>}
      </h3>
      <div onMouseDown={(e) => e.stopPropagation()}>{headerActions}</div>
    </div>
  );

  const gridEl = hasClips ? (
    <ClipGrid
      clips={clips}
      segments={segs}
      activeClip={activeClip}
      onSelectClip={onSelectClip}
      thumbUrl={thumbUrl}
    />
  ) : (
    <div
      style={{
        opacity: 0.6,
        fontSize: 11,
        padding: '12px 8px',
        border: '1px dashed #444',
        borderRadius: 4,
        textAlign: 'center',
      }}
    >
      {jobDone
        ? (saveClipsEnabled
            ? '本次未生成任何 clip（可能没切到段）。重新跑一段能产生 segments 的视频试试。'
            : '参数区未勾选「切出每段 clip mp4」——勾上后重新跑一次即可。')
        : (saveClipsEnabled
            ? '等待 job 完成 —— 完成后这里会显示每个 clip 的第一帧预览卡片。'
            : '参数区未勾选「切出每段 clip mp4」——勾上后重新跑一次即可。')}
    </div>
  );

  useEffect(() => {
    if (mode !== 'floating') return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      setPos({ x: d.origX + dx, y: d.origY + dy });
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [mode]);

  if (mode === 'docked') {
    return (
      <div ref={barRef} style={{ ...bodyStyle, flexShrink: 0 }}>
        {headerEl}
        {gridEl}
      </div>
    );
  }

  // Floating overlay
  return (
    <div
      ref={barRef}
      style={{
        ...bodyStyle,
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: 'min(1100px, calc(100vw - 48px))',
        zIndex: 1000,
      }}
    >
      {headerEl}
      {gridEl}
    </div>
  );
}