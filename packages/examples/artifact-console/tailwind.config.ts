import type { Config } from 'tailwindcss';
import uiPreset from '../../ui/tailwind.config';

export default {
  presets: [uiPreset as unknown as Config],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    // The reused chart catalog styles itself with the ui package's tokens.
    '../../ui/src/components/charts/**/*.tsx',
    '../../ui/src/components/a2ui/**/*.tsx',
    '../../ui/src/lib/**/*.ts',
  ],
} satisfies Config;
