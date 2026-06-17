import React from 'react';

export default function LevelShield({ name, color, textColor, size = 'large' }) {
  const isLarge = size === 'large';
  const w = isLarge ? 120 : 28;
  const h = isLarge ? 140 : 32;
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
