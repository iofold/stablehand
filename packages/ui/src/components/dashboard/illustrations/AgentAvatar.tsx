import React from 'react';

export type HarnessType = string;

interface AgentAvatarProps extends React.SVGProps<SVGSVGElement> {
  harnessType?: HarnessType;
  className?: string;
}

export const AgentAvatar: React.FC<AgentAvatarProps> = ({ harnessType = 'default', className = '', ...props }) => {
  const renderShape = () => {
    switch (harnessType) {
      case 'langgraph':
        return (
          <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="20" cy="12" r="3" className="text-accent-400" fill="currentColor" fillOpacity="0.2" />
            <circle cx="12" cy="28" r="3" className="text-surface-400" />
            <circle cx="28" cy="28" r="3" className="text-surface-400" />
            <path d="M18.5 14.5l-5 10.5" className="text-surface-600" />
            <path d="M21.5 14.5l5 10.5" className="text-surface-600" />
            <path d="M14.5 28h11" className="text-surface-600" />
          </g>
        );
      case 'claude-agents':
        return (
          <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 8l10 12-10 12-10-12z" className="text-accent-500" fill="currentColor" fillOpacity="0.1" />
            <path d="M20 14l5 6-5 6-5-6z" className="text-surface-300" />
            <circle cx="20" cy="20" r="1.5" className="text-accent-400" fill="currentColor" />
          </g>
        );
      case 'pi-agent':
        return (
          <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="20" cy="20" r="10" className="text-surface-600" strokeDasharray="4 4" />
            <circle cx="20" cy="20" r="6" className="text-accent-400" fill="currentColor" fillOpacity="0.15" />
            <circle cx="20" cy="10" r="2" className="text-surface-300" fill="currentColor" />
            <circle cx="28.66" cy="25" r="2" className="text-surface-400" fill="currentColor" />
            <circle cx="11.34" cy="25" r="2" className="text-surface-400" fill="currentColor" />
          </g>
        );
      default:
        return (
          <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <rect x="12" y="12" width="16" height="16" rx="4" className="text-surface-500" />
            <circle cx="20" cy="20" r="3" className="text-accent-400" fill="currentColor" fillOpacity="0.2" />
            <path d="M20 8v4M20 28v4M8 20h4M28 20h4" className="text-surface-600" />
          </g>
        );
    }
  };

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 40 40"
      width="40"
      height="40"
      className={`shrink-0 ${className}`}
      role="img"
      aria-label={`${harnessType} agent avatar`}
      {...props}
    >
      <title>{harnessType} agent avatar</title>
      <rect width="40" height="40" rx="8" className="fill-surface-800/50" />
      {renderShape()}
    </svg>
  );
};
