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
        'do-dark': '#1a1a2e',
        'do-darker': '#0f0f1e',
        'do-green': '#00ff88',
        'do-red': '#ff6b6b',
      },
    },
  },
  plugins: [],
};
