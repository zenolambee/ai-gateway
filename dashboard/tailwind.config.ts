import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(214 32% 91%)',
        input: 'hsl(214 32% 91%)',
        ring: 'hsl(221 83% 53%)',
        background: 'hsl(0 0% 100%)',
        foreground: 'hsl(222 47% 11%)',
        muted: { DEFAULT: 'hsl(210 40% 96%)', foreground: 'hsl(215 16% 47%)' },
        primary: { DEFAULT: 'hsl(221 83% 53%)', foreground: 'hsl(0 0% 100%)' },
        success: { DEFAULT: 'hsl(142 71% 45%)', foreground: 'hsl(0 0% 100%)' },
        warning: { DEFAULT: 'hsl(38 92% 50%)', foreground: 'hsl(0 0% 100%)' },
        danger: { DEFAULT: 'hsl(0 72% 51%)', foreground: 'hsl(0 0% 100%)' },
        card: 'hsl(0 0% 100%)',
      },
      borderRadius: {
        lg: '0.75rem',
        md: '0.5rem',
        sm: '0.375rem',
      },
      boxShadow: {
        card: '0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.04)',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
