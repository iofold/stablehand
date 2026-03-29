import React from 'react';

export type AgentStatus = 'running' | 'idle' | 'error' | 'stopped' | string;

interface StatusPulseProps extends React.SVGProps<SVGSVGElement> {
  status?: AgentStatus;
  className?: string;
}

export const StatusPulse: React.FC<StatusPulseProps> = ({ status = 'idle', className = '', ...props }) => {
  const getStatusClasses = () => {
    switch (status) {
      case 'running':
        return {
          color: 'text-status-success',
          animation: 'motion-safe:animate-pulse-subtle',
        };
      case 'idle':
        return {
          color: 'text-surface-400',
          animation: 'motion-safe:animate-breathe',
        };
      case 'error':
        return {
          color: 'text-status-error',
          animation: 'motion-safe:animate-pulse',
        };
      case 'stopped':
      default:
        return {
          color: 'text-surface-600',
          animation: '',
        };
    }
  };

  const { color, animation } = getStatusClasses();

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      className={`shrink-0 ${className}`}
      role="img"
      aria-label={`Status: ${status}`}
      {...props}
    >
      <title>Status: {status}</title>
      <circle
        cx="8"
        cy="8"
        r="4"
        className={`${color} ${animation}`}
        fill="currentColor"
      />
      {status === 'running' && (
        <circle
          cx="8"
          cy="8"
          r="6"
          className={`text-status-success motion-safe:animate-ping opacity-20`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
      )}
    </svg>
  );
};
