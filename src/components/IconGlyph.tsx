import React from 'react';
import type { CardColor, IconSlot } from '../engine/types';

export const COLOR_THEMES: Record<
  CardColor,
  {
    bg: string;
    header: string;
    border: string;
    soft: string;
    text: string;
    badgeText: string;
    shapeLabel: string;
  }
> = {
  red: {
    bg: '#8E2920',
    header: '#6B1C15',
    border: '#C95A4E',
    soft: '#F9E8E6',
    text: '#FFFFFF',
    badgeText: '#6B1C15',
    shapeLabel: 'Octagon',
  },
  yellow: {
    bg: '#B87B14',
    header: '#8B5B0A',
    border: '#E5B248',
    soft: '#FBF3DC',
    text: '#FFFFFF',
    badgeText: '#784E06',
    shapeLabel: 'Sunburst',
  },
  green: {
    bg: '#235B34',
    header: '#174224',
    border: '#4E9964',
    soft: '#E5F2E8',
    text: '#FFFFFF',
    badgeText: '#174224',
    shapeLabel: 'Square',
  },
  blue: {
    bg: '#1E4E79',
    header: '#153858',
    border: '#538CC2',
    soft: '#E6EFF8',
    text: '#FFFFFF',
    badgeText: '#153858',
    shapeLabel: 'Circle',
  },
  purple: {
    bg: '#553368',
    header: '#3D224C',
    border: '#9367AC',
    soft: '#F0E9F5',
    text: '#FFFFFF',
    badgeText: '#3D224C',
    shapeLabel: 'Diamond',
  },
};

export const IconGlyph: React.FC<{
  slot: IconSlot;
  size?: number;
  className?: string;
}> = ({ slot, size = 18, className = '' }) => {
  switch (slot) {
    case 'tower':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          shapeRendering="geometricPrecision"
          className={className}
          aria-hidden="true"
        >
          <rect x="2" y="2" width="20" height="20" rx="3" fill="#4A2D28" stroke="#1F1A17" strokeWidth="1.5" />
          <path
            d="M5.5 19.5V9.5H5V5.5H8V7.5H10.5V5.5H13.5V7.5H16V5.5H19V9.5H18.5V19.5H14.5V14.8C14.5 13.4 13.4 12.3 12 12.3C10.6 12.3 9.5 13.4 9.5 14.8V19.5H5.5Z"
            fill="#F0E5CF"
            stroke="#1F1A17"
            strokeWidth="1.15"
            strokeLinejoin="round"
          />
          <rect x="6.5" y="10" width="11" height="1.2" fill="#4A2D28" />
        </svg>
      );
    case 'coin':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          shapeRendering="geometricPrecision"
          className={className}
          aria-hidden="true"
        >
          <rect x="2" y="2" width="20" height="20" rx="3" fill="#7D560A" stroke="#1F1A17" strokeWidth="1.5" />
          <path
            d="M4.5 16.5L5.8 8.2L9.8 12.2L12 5.8L14.2 12.2L18.2 8.2L19.5 16.5H4.5Z"
            fill="#F8CE4E"
            stroke="#1F1A17"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <rect x="5" y="17.2" width="14" height="2.3" rx="0.6" fill="#F8CE4E" stroke="#1F1A17" strokeWidth="1" />
        </svg>
      );
    case 'leaf':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          shapeRendering="geometricPrecision"
          className={className}
          aria-hidden="true"
        >
          <rect x="2" y="2" width="20" height="20" rx="3" fill="#184726" stroke="#1F1A17" strokeWidth="1.5" />
          <path
            d="M17.5 6.5C11 6.5 6.5 10.5 6.5 17C13 17 17.5 13 17.5 6.5Z"
            fill="#7CC76E"
            stroke="#1F1A17"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path d="M6.5 17.5L14.5 9.5" stroke="#184726" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case 'lightbulb':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          shapeRendering="geometricPrecision"
          className={className}
          aria-hidden="true"
        >
          <rect x="2" y="2" width="20" height="20" rx="3" fill="#4B345E" stroke="#1F1A17" strokeWidth="1.5" />
          <path
            d="M12 5C9.2 5 7 7.1 7 9.8C7 11.7 8.1 13.3 9.5 14.3V16H14.5V14.3C15.9 13.3 17 11.7 17 9.8C17 7.1 14.8 5 12 5Z"
            fill="#F7EAD9"
            stroke="#1F1A17"
            strokeWidth="1.1"
          />
          <rect x="9.5" y="16.8" width="5" height="2.2" rx="0.8" fill="#D5B88E" stroke="#1F1A17" strokeWidth="0.9" />
        </svg>
      );
    case 'factory':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          shapeRendering="geometricPrecision"
          className={className}
          aria-hidden="true"
        >
          <rect x="2" y="2" width="20" height="20" rx="3" fill="#63261F" stroke="#1F1A17" strokeWidth="1.5" />
          <path
            d="M4.5 18.8V10.5L8.8 13.3V10.5L13.1 13.3V10.5L16.2 12.5V5.2H19.3V18.8H4.5Z"
            fill="#E58574"
            stroke="#1F1A17"
            strokeWidth="1.15"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'clock':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          shapeRendering="geometricPrecision"
          className={className}
          aria-hidden="true"
        >
          <rect x="2" y="2" width="20" height="20" rx="3" fill="#173A5C" stroke="#1F1A17" strokeWidth="1.5" />
          <circle cx="12" cy="12" r="6.2" fill="#DCECF9" stroke="#1F1A17" strokeWidth="1.2" />
          <path d="M12 8.2V12L14.8 13.6" stroke="#173A5C" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'persona':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          shapeRendering="geometricPrecision"
          className={className}
          aria-hidden="true"
        >
          <rect x="2" y="2" width="20" height="20" rx="3" fill="#1F5B8E" stroke="#1F1A17" strokeWidth="1.5" />
          <circle cx="12" cy="8.5" r="3" fill="#F5EFE2" stroke="#1F1A17" strokeWidth="1.1" />
          <path
            d="M6.8 18.5C7.3 15 9.4 13.2 12 13.2C14.6 13.2 16.7 15 17.2 18.5H6.8Z"
            fill="#F5EFE2"
            stroke="#1F1A17"
            strokeWidth="1.1"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'hexagon':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          shapeRendering="geometricPrecision"
          className={className}
          aria-hidden="true"
        >
          <polygon
            points="12,3 20,7.5 20,16.5 12,21 4,16.5 4,7.5"
            fill="#2E2620"
            stroke="#D9C7A3"
            strokeWidth="1.5"
          />
        </svg>
      );
  }
};

export const ColorShapeMark: React.FC<{ color: CardColor; size?: number }> = ({
  color,
  size = 14,
}) => {
  const theme = COLOR_THEMES[color];
  switch (color) {
    case 'red':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="geometricPrecision" aria-hidden="true">
          <polygon points="5,1 11,1 15,5 15,11 11,15 5,15 1,11 1,5" fill={theme.bg} stroke="#F5EFE2" strokeWidth="1.2" />
        </svg>
      );
    case 'yellow':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="geometricPrecision" aria-hidden="true">
          <polygon points="8,1 10,5 15,4 12,8 15,12 10,11 8,15 6,11 1,12 4,8 1,4 6,5" fill={theme.bg} stroke="#F5EFE2" strokeWidth="1.1" />
        </svg>
      );
    case 'green':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="geometricPrecision" aria-hidden="true">
          <rect x="2" y="2" width="12" height="12" rx="1.5" fill={theme.bg} stroke="#F5EFE2" strokeWidth="1.2" />
        </svg>
      );
    case 'blue':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="geometricPrecision" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill={theme.bg} stroke="#F5EFE2" strokeWidth="1.2" />
        </svg>
      );
    case 'purple':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="geometricPrecision" aria-hidden="true">
          <polygon points="8,1 15,8 8,15 1,8" fill={theme.bg} stroke="#F5EFE2" strokeWidth="1.2" />
        </svg>
      );
  }
};
