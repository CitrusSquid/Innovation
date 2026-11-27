import { useEffect, useRef } from 'react';

function isInteractiveInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function findScrollableAncestor(start: EventTarget | null): HTMLElement {
  let node = start instanceof HTMLElement ? start : null;
  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    const canScrollY =
      (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight + 1;
    const canScrollX =
      (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
      node.scrollWidth > node.clientWidth + 1;
    if (canScrollY || canScrollX) {
      return node;
    }
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

/**
 * Enables mouse click-and-drag scrolling across the viewport or nearest scrollable modal/panel
 * while preserving normal clicks (< 6px pointer movement). Touch scrolling remains native.
 */
export function useDragScroll() {
  const suppressClickRef = useRef(false);

  useEffect(() => {
    let active = false;
    let dragged = false;
    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;
    let startScrollTop = 0;
    let scroller: HTMLElement | null = null;

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      if (isInteractiveInput(e.target)) return;

      scroller = findScrollableAncestor(e.target);
      active = true;
      dragged = false;
      suppressClickRef.current = false;
      startX = e.clientX;
      startY = e.clientY;
      startScrollLeft = scroller.scrollLeft;
      startScrollTop = scroller.scrollTop;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!active || !scroller) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!dragged && Math.hypot(dx, dy) > 6) {
        dragged = true;
        suppressClickRef.current = true;
        document.body.classList.add('select-none', 'cursor-grabbing');
      }

      if (dragged) {
        scroller.scrollLeft = startScrollLeft - dx;
        scroller.scrollTop = startScrollTop - dy;
      }
    };

    const stopDrag = () => {
      if (!active) return;
      active = false;
      scroller = null;
      document.body.classList.remove('select-none', 'cursor-grabbing');
      if (dragged) {
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 50);
      }
    };

    const onClickCapture = (e: MouseEvent) => {
      if (suppressClickRef.current) {
        e.preventDefault();
        e.stopPropagation();
        suppressClickRef.current = false;
      }
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    window.addEventListener('click', onClickCapture, true);

    return () => {
      document.body.classList.remove('select-none', 'cursor-grabbing');
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
      window.removeEventListener('click', onClickCapture, true);
    };
  }, []);
}
