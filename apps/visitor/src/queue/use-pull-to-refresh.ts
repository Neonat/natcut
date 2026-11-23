import { useRef } from 'react';
import type { TouchEventHandler } from 'react';

export function usePullToRefresh(refresh: () => void, threshold = 64) {
  const start = useRef<number | null>(null);
  const pulled = useRef(false);
  const onTouchStart: TouchEventHandler<HTMLElement> = (event) => {
    if (window.scrollY <= 0) {
      start.current = event.touches[0]?.clientY ?? null;
      pulled.current = false;
    }
  };
  const onTouchMove: TouchEventHandler<HTMLElement> = (event) => {
    if (start.current === null) return;
    pulled.current = (event.touches[0]?.clientY ?? start.current) - start.current >= threshold;
  };
  const onTouchEnd: TouchEventHandler<HTMLElement> = () => {
    if (pulled.current) refresh();
    start.current = null;
    pulled.current = false;
  };
  return { onTouchStart, onTouchMove, onTouchEnd };
}
