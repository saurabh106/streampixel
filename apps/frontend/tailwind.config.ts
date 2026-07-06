import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#070913',
        foreground: '#F1F5F9',
        primary: {
          DEFAULT: '#6366F1',
          hover: '#4F46E5',
          light: '#818CF8',
        },
        card: {
          DEFAULT: 'rgba(15, 23, 42, 0.65)',
          border: 'rgba(255, 255, 255, 0.05)',
        },
        border: 'rgba(255, 255, 255, 0.08)',
        sidebar: '#0C0E1C',
        accent: {
          cyan: '#06B6D4',
          violet: '#8B5CF6',
          pink: '#EC4899',
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-conic': 'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
        'glass-gradient':
          'linear-gradient(135deg, rgba(255, 255, 255, 0.03) 0%, rgba(255, 255, 255, 0.01) 100%)',
      },
      boxShadow: {
        glass: '0 8px 32px 0 rgba(0, 0, 0, 0.3)',
        'glass-accent': '0 8px 32px 0 rgba(99, 102, 241, 0.12)',
      },
    },
  },
  plugins: [],
};
export default config;
