/**
 * The Stablehand logomark: a horseshoe arch sheltering a single node — the
 * stablehand tends the agent. One continuous stroke plus a dot, drawn in
 * currentColor so it inherits its context's accent.
 */
export function BrandMark({
  size = 24,
  detailed = false,
  className,
}: {
  size?: number;
  /** Adds the nail holes; only legible at ~28px and above. */
  detailed?: boolean;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M4.7 19.3h2.5v-6.5a4.8 4.8 0 0 1 9.6 0v6.5h2.5"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="15" r="2" fill="currentColor" />
      {detailed && (
        <g fill="var(--brand-mark-hole, #0b0b0d)">
          <circle cx="7.2" cy="15.6" r="0.55" />
          <circle cx="16.8" cy="15.6" r="0.55" />
          <circle cx="8.7" cy="9.4" r="0.55" />
          <circle cx="15.3" cy="9.4" r="0.55" />
        </g>
      )}
    </svg>
  );
}
