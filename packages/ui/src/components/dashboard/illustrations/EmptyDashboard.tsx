import React from 'react';

interface EmptyDashboardProps extends React.SVGProps<SVGSVGElement> {
  className?: string;
}

export const EmptyDashboard: React.FC<EmptyDashboardProps> = ({ className = '', ...props }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 200 150"
      width="200"
      height="150"
      className={`shrink-0 ${className}`}
      role="img"
      aria-label="Empty dashboard illustration"
      {...props}
    >
      <title>Empty dashboard</title>
      <defs>
        <linearGradient id="empty-dash-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="currentColor" className="text-surface-800" />
          <stop offset="100%" stopColor="currentColor" className="text-surface-900" />
        </linearGradient>
        <radialGradient id="empty-dash-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.1" className="text-accent-400" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" className="text-surface-900" />
        </radialGradient>
      </defs>

      <rect width="200" height="150" rx="16" fill="url(#empty-dash-grad)" />
      <circle cx="100" cy="75" r="60" fill="url(#empty-dash-glow)" />

      <g stroke="currentColor" strokeWidth="1" fill="none" className="text-surface-700">
        <path d="M40 50L80 30L120 40L160 20" strokeDasharray="4 4" />
        <path d="M30 100L70 120L110 90L150 130" strokeDasharray="4 4" />
        <path d="M80 30L70 120" strokeDasharray="4 4" />
        <path d="M120 40L110 90" strokeDasharray="4 4" />
      </g>

      <g fill="currentColor" className="text-surface-600">
        <circle cx="40" cy="50" r="3" />
        <circle cx="80" cy="30" r="4" />
        <circle cx="120" cy="40" r="3" />
        <circle cx="160" cy="20" r="2" />
        <circle cx="30" cy="100" r="2" />
        <circle cx="70" cy="120" r="3" />
        <circle cx="110" cy="90" r="4" />
        <circle cx="150" cy="130" r="3" />
      </g>

      <g stroke="currentColor" strokeWidth="1.5" fill="none" className="text-surface-500">
        <circle cx="100" cy="75" r="16" className="text-surface-700" fill="currentColor" />
        <path d="M94 75h12M100 69v12" className="text-surface-400" />
        <circle cx="100" cy="75" r="24" strokeDasharray="2 6" className="text-surface-600" />
      </g>
    </svg>
  );
};
