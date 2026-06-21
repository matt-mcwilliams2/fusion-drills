import React from 'react';

export default function LevelShield({ name, color, textColor, isPrestige, subtitle, size = 'large' }) {
  const isLarge = size === 'large';
  const w = isLarge ? 120 : 28;
  const h = isLarge ? 140 : 32;

  if (isPrestige) {
    const mainFontSize = isLarge ? 13 : 4.5;
    const subFontSize = isLarge ? 9 : 3;
    const crownSize = isLarge ? 1 : 0.35;

    return (
      <svg width={w} height={h} viewBox="0 0 120 140" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Outer glow for prestige */}
        <defs>
          <filter id="prestigeGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="prestigeBorder" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffd700" />
            <stop offset="50%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#ffd700" />
          </linearGradient>
        </defs>
        {/* Shield shape with gold gradient border */}
        <path
          d="M60 2 L110 20 Q115 22 115 28 L115 70 Q115 105 60 135 Q5 105 5 70 L5 28 Q5 22 10 20 Z"
          fill={color}
          stroke="url(#prestigeBorder)"
          strokeWidth="4"
          filter="url(#prestigeGlow)"
        />
        {/* Inner border accent */}
        <path
          d="M60 8 L106 24 Q109 25.5 109 30 L109 69 Q109 100 60 128 Q11 100 11 69 L11 30 Q11 25.5 14 24 Z"
          fill="none"
          stroke="rgba(255,215,0,0.3)"
          strokeWidth="1"
        />
        {/* Crown at top */}
        <g transform={`translate(60, ${isLarge ? 28 : 28}) scale(${crownSize})`}>
          <polygon
            points="-16,6 -12,-6 -6,2 0,-10 6,2 12,-6 16,6"
            fill="#ffd700"
            stroke="rgba(0,0,0,0.2)"
            strokeWidth="0.5"
          />
        </g>
        {/* Main name: Ronaldo */}
        <text
          x="60"
          y="62"
          textAnchor="middle"
          dominantBaseline="central"
          fill={textColor}
          fontSize={mainFontSize}
          fontWeight="900"
          fontFamily="Inter, -apple-system, BlinkMacSystemFont, sans-serif"
          letterSpacing="0.5"
        >
          Ronaldo
        </text>
        {/* Subtitle: club/team */}
        {subtitle && (
          <text
            x="60"
            y="80"
            textAnchor="middle"
            dominantBaseline="central"
            fill={textColor}
            fontSize={subFontSize}
            fontWeight="600"
            fontFamily="Inter, -apple-system, BlinkMacSystemFont, sans-serif"
            opacity="0.85"
          >
            {subtitle}
          </text>
        )}
        {/* Star at bottom */}
        <polygon
          points="60,100 63,108 72,108 65,113 67,122 60,117 53,122 55,113 48,108 57,108"
          fill="#ffd700"
          opacity="0.9"
          transform={isLarge ? '' : ''}
        />
      </svg>
    );
  }

  // Standard (non-prestige) shield
  const fontSize = isLarge ? 14 : 5;

  return (
    <svg width={w} height={h} viewBox="0 0 120 140" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M60 2 L110 20 Q115 22 115 28 L115 70 Q115 105 60 135 Q5 105 5 70 L5 28 Q5 22 10 20 Z"
        fill={color}
        stroke="rgba(255,255,255,0.3)"
        strokeWidth="3"
      />
      <text
        x="60"
        y="70"
        textAnchor="middle"
        dominantBaseline="central"
        fill={textColor}
        fontSize={fontSize}
        fontWeight="800"
        fontFamily="Inter, -apple-system, BlinkMacSystemFont, sans-serif"
      >
        {name}
      </text>
    </svg>
  );
}
