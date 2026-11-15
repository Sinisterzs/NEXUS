import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/utils';

interface TooltipProps {
  content: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  children: React.ReactNode;
  className?: string;
  delayMs?: number;
  portal?: boolean;
}

interface PortalPosition {
  top: number;
  left: number;
}

const PORTAL_TRANSFORM_CLASSES: Record<'top' | 'bottom' | 'left' | 'right', string> = {
  top: '-translate-x-1/2 -translate-y-full',
  bottom: '-translate-x-1/2',
  left: '-translate-x-full -translate-y-1/2',
  right: '-translate-y-1/2',
};

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  position = 'top',
  children,
  className,
  delayMs = 150,
  portal = false,
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [portalPos, setPortalPos] = useState<PortalPosition | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();

  const clearTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const computePortalPosition = useCallback((): PortalPosition | null => {
    const el = wrapperRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    switch (position) {
      case 'right':
        return { top: rect.top + rect.height / 2, left: rect.right + 8 };
      case 'left':
        return { top: rect.top + rect.height / 2, left: rect.left - 8 };
      case 'top':
        return { top: rect.top - 8, left: rect.left + rect.width / 2 };
      case 'bottom':
        return { top: rect.bottom + 8, left: rect.left + rect.width / 2 };
    }
  }, [position]);

  const handleMouseEnter = () => {
    clearTimer();
    timeoutRef.current = window.setTimeout(() => {
      if (portal) {
        const coords = computePortalPosition();
        if (!coords) return;
        setPortalPos(coords);
      }
      setIsVisible(true);
    }, delayMs);
  };

  const handleMouseLeave = useCallback(() => {
    clearTimer();
    setIsVisible(false);
    setPortalPos(null);
  }, [clearTimer]);

  useEffect(() => {
    return () => {
      clearTimer();
    };
  }, [clearTimer]);

  useEffect(() => {
    if (!isVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleMouseLeave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isVisible, handleMouseLeave]);

  useEffect(() => {
    if (!portal || !isVisible) return;

    const handleAncestorScroll = (event: Event) => {
      const target = event.target;
      if (
        target === document ||
        target === window ||
        (target instanceof Node && wrapperRef.current && target.contains(wrapperRef.current))
      ) {
        handleMouseLeave();
      }
    };

    const handleResize = () => {
      const coords = computePortalPosition();
      if (coords) {
        setPortalPos(coords);
      } else {
        handleMouseLeave();
      }
    };

    window.addEventListener('scroll', handleAncestorScroll, true);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('scroll', handleAncestorScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [portal, isVisible, computePortalPosition, handleMouseLeave]);

  const positionClasses = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  const tooltipClassName =
    'pointer-events-none px-2.5 py-1 text-[11px] font-medium text-nexus-text bg-nexus-panel border border-nexus-border rounded shadow-md whitespace-nowrap transition-nexus';

  return (
    <div
      ref={wrapperRef}
      className={cn('relative inline-flex items-center justify-center', className)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleMouseEnter}
      onBlur={handleMouseLeave}
    >
      {children}
      {isVisible &&
        (portal ? (
          portalPos &&
          typeof document !== 'undefined' &&
          createPortal(
            <div
              id={tooltipId}
              role="tooltip"
              style={{
                position: 'fixed',
                top: portalPos.top,
                left: portalPos.left,
                zIndex: 9999,
              }}
              className={cn(tooltipClassName, PORTAL_TRANSFORM_CLASSES[position])}
            >
              {content}
            </div>,
            document.body
          )
        ) : (
          <div
            id={tooltipId}
            role="tooltip"
            className={cn('absolute z-50', tooltipClassName, positionClasses[position])}
          >
            {content}
          </div>
        ))}
    </div>
  );
};
