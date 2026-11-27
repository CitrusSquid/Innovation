import { useEffect, useRef } from 'react';
import type React from 'react';

export interface UseLongPressOptions {
  durationMs?: number;
  moveThresholdPx?: number;
  onLongPress: () => void;
  onClick?: () => void;
}

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onClick: (e: React.MouseEvent) => void;
}

/**
 * Triggers `onLongPress` when the user holds down the button for `durationMs`
 * without dragging beyond `moveThresholdPx`, while preserving normal `onClick`.
 */
export function useLongPress({
  durationMs = 5000,
  moveThresholdPx = 12,
  onLongPress,
  onClick,
}: UseLongPressOptions): LongPressHandlers {
  const timerRef = useRef<number | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const triggeredRef = useRef(false);
  const onLongPressRef = useRef(onLongPress);
  const onClickRef = useRef(onClick);

  onLongPressRef.current = onLongPress;
  onClickRef.current = onClick;

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPosRef.current = null;
  };

  useEffect(() => clearTimer, []);

  return {
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      clearTimer();
      triggeredRef.current = false;
      startPosRef.current = { x: e.clientX, y: e.clientY };
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        startPosRef.current = null;
        triggeredRef.current = true;
        onLongPressRef.current();
      }, durationMs);
    },
    onPointerMove: (e) => {
      const start = startPosRef.current;
      if (!start || timerRef.current === null) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > moveThresholdPx) {
        clearTimer();
      }
    },
    onPointerUp: clearTimer,
    onPointerLeave: clearTimer,
    onPointerCancel: clearTimer,
    onContextMenu: (e) => {
      e.preventDefault();
    },
    onClick: (e) => {
      if (triggeredRef.current) {
        triggeredRef.current = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      onClickRef.current?.();
    },
  };
}
