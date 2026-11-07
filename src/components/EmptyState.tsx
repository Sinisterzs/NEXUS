import React from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from '../lib/utils';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actionText?: string;
  onAction?: () => void;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  actionText,
  onAction,
  className,
}) => {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center p-8 max-w-md mx-auto my-auto',
        className
      )}
    >
      <div className="w-14 h-14 rounded-2xl bg-nexus-surface border border-nexus-border flex items-center justify-center text-nexus-muted mb-4 shadow-sm">
        <Icon className="w-7 h-7 text-nexus-muted" strokeWidth={1.5} />
      </div>
      <h3 className="text-base font-semibold text-nexus-text mb-1.5">{title}</h3>
      <p className="text-sm text-nexus-muted mb-6 leading-relaxed">{description}</p>
      {actionText && onAction && (
        <button
          onClick={onAction}
          className="px-4 py-2 text-xs font-semibold rounded bg-nexus-panel hover:bg-nexus-surface text-nexus-text border border-nexus-border hover:border-nexus-accent transition-colors duration-150"
        >
          {actionText}
        </button>
      )}
    </div>
  );
};
