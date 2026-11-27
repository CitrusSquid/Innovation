import { useEffect, useRef } from 'react';

function isInteractiveInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function getOpenDialog(): HTMLElement | null {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
  return dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
}

function isScrollableElement(node: HTMLElement): boolean {
  const style = window.getComputedStyle(node);
  const canScrollY =
    (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
    node.scrollHeight > node.clientHeight + 1;
  const canScrollX =
    (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
    node.scrollWidth > node.clientWidth + 1;
  return canScrollY || canScrollX;
}

function findScrollableAncestor(start: EventTarget | null, boundary: HTMLElement | null): HTMLElement | null {
  let node = start instanceof HTMLElement ? start : null;
  while (node && node !== document.body && node !== document.documentElement) {
    if (isScrollableElement(node)) {
      return node;
    }
    if (boundary && node === boundary) {
      return null;
    }
    node = node.parentElement;
  }
  if (boundary) {
    return null;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

/**
 * Enables mouse click-and-drag scrolling across the viewport or nearest scrollable modal/panel
 * while preserving normal clicks (< 6px pointer movement), and locks background scrolling whenever
 * a modal dialog (`[role="dialog"][aria-modal="true"]`) is open.
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

    const syncModalScrollLock = () => {
      const hasOpenDialog = getOpenDialog() !== null;
      document.documentElement.classList.toggle('modal-open', hasOpenDialog);
      document.body.classList.toggle('modal-open', hasOpenDialog);
    };

    syncModalScrollLock();
    const observer = new MutationObserver(syncModalScrollLock);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['role', 'aria-modal'],
    });

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      if (isInteractiveInput(e.target)) return;

      const openDialog = getOpenDialog();
      scroller = findScrollableAncestor(e.target, openDialog);
      if (!scroller) return;

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

    const onTouchMove = (e: TouchEvent) => {
      const openDialog = getOpenDialog();
      if (!openDialog) return;
      const targetNode = e.target instanceof Node ? e.target : null;
      if (!targetNode || !openDialog.contains(targetNode)) {
        if (e.cancelable) e.preventDefault();
        return;
      }
      const scrollable = findScrollableAncestor(e.target, openDialog);
      if (!scrollable && e.cancelable) {
        e.preventDefault();
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
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('click', onClickCapture, true);

    return () => {
      observer.disconnect();
      document.documentElement.classList.remove('modal-open');
      document.body.classList.remove('modal-open', 'select-none', 'cursor-grabbing');
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('click', onClickCapture, true);
    };
  }, []);
}
