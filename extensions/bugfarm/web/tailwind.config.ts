import type { Config } from 'tailwindcss';
import { fileURLToPath } from 'node:url';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: [here('./index.html'), here('./src/**/*.{ts,tsx}')],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        ground: token('ground'),
        well: token('well'),
        card: token('card'),
        raised: token('raised'),
        line: token('line'),
        ink: token('ink'),
        'ink-2': token('ink-2'),
        'ink-3': token('ink-3'),
        pollen: token('pollen'),
        sprout: token('sprout'),
        ember: token('ember'),
        sky: token('sky'),
        chart: token('chart'),
      },
      fontFamily: {
        sans: ['"Archivo Variable"', 'Archivo', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        card: '10px',
        well: '16px',
      },
    },
  },
  plugins: [],
} satisfies Config;
