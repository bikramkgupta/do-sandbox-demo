/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'do-blue': '#0080ff',
        'do-blue-dim': '#0066cc',
        'do-dark': '#1a1a2e',
        'do-darker': '#0f0f1e',
        'do-darkest': '#080812',
        'do-green': '#00ff88',
        'do-green-dim': '#00cc6a',
        'do-red': '#ff6b6b',
        'do-purple': '#a855f7',
        'do-cyan': '#22d3ee',
        'do-yellow': '#ffd93d',
      },
    },
  },
  plugins: [],
};
