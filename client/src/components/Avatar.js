import React from 'react';

export default function Avatar({ firstName, lastName, level, latestBadgeEmoji, size = 38 }) {
  const bgColor = level?.color || '#f77c00';
  const textColor = level?.textColor || '#ffffff';
  const badgeSize = Math.round(size * 0.3);
  const fontSize = size * 0.38;

  return (
    <div
      className="avatar-wrapper"
      style={{ width: size, height: size, position: 'relative', flexShrink: 0 }}
    >
      <div
        className="avatar-circle"
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: bgColor,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
          fontSize: `${fontSize}px`,
          color: textColor,
          lineHeight: 1,
        }}
      >
        {firstName?.[0]}{lastName?.[0]}
      </div>
      {latestBadgeEmoji && (
        <span
          className="avatar-badge"
          style={{
            position: 'absolute',
            top: -badgeSize * 0.5,
            right: -badgeSize * 0.3,
            fontSize: `${badgeSize}px`,
            lineHeight: 1,
            pointerEvents: 'none',
          }}
        >
          {latestBadgeEmoji}
        </span>
      )}
    </div>
  );
}
