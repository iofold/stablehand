import React, { useEffect, useState, useRef } from 'react';

interface AnimatedCounterProps {
  value: number;
  duration?: number;
  className?: string;
}

export const AnimatedCounter: React.FC<AnimatedCounterProps> = ({
  value,
  duration = 500,
  className = '',
}) => {
  const [displayValue, setDisplayValue] = useState(value);
  const [isAnimating, setIsAnimating] = useState(false);
  const prevValueRef = useRef(value);

  useEffect(() => {
    if (value === prevValueRef.current) return;

    const startValue = prevValueRef.current;
    const endValue = value;
    const startTime = performance.now();

    setIsAnimating(true);

    const animate = (currentTime: number) => {
      const elapsedTime = currentTime - startTime;
      const progress = Math.min(elapsedTime / duration, 1);
      
      const easeProgress = 1 - Math.pow(1 - progress, 4);
      
      const currentValue = Math.round(startValue + (endValue - startValue) * easeProgress);
      setDisplayValue(currentValue);

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        setIsAnimating(false);
        prevValueRef.current = endValue;
      }
    };

    requestAnimationFrame(animate);
  }, [value, duration]);

  return (
    <span
      className={`inline-block transition-transform ${
        isAnimating ? 'motion-safe:animate-count-up' : ''
      } ${className}`}
    >
      {displayValue}
    </span>
  );
};

interface HoverGlowProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  glowColor?: string;
}

export const HoverGlow: React.FC<HoverGlowProps> = ({
  children,
  className = '',
  glowColor = 'rgba(45, 212, 191, 0.15)',
  ...props
}) => {
  return (
    <div
      className={`group relative transition-all duration-300 ${className}`}
      {...props}
    >
      <div
        className="absolute -inset-0.5 rounded-xl opacity-0 blur transition duration-500 group-hover:opacity-100"
        style={{ backgroundColor: glowColor }}
        aria-hidden="true"
      />
      <div className="relative h-full w-full">
        {children}
      </div>
    </div>
  );
};

interface StaggeredRevealProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  staggerDelay?: number;
  baseDelay?: number;
}

export const StaggeredReveal: React.FC<StaggeredRevealProps> = ({
  children,
  className = '',
  staggerDelay = 75,
  baseDelay = 0,
  ...props
}) => {
  const childrenArray = React.Children.toArray(children);

  return (
    <div className={className} {...props}>
      {childrenArray.map((child, index) => {
        const key = React.isValidElement(child) && child.key ? child.key : `staggered-child-${index}`;
        return (
          <div
            key={key}
            className="opacity-0 motion-safe:animate-slide-up"
            style={{
              animationDelay: `${baseDelay + index * staggerDelay}ms`,
              animationFillMode: 'forwards',
            }}
          >
            {child}
          </div>
        );
      })}
    </div>
  );
};
