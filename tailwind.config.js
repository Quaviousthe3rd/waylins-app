/** @type {import('tailwindcss').Config} */
export default {
  // Explicit directories rather than a bare "./**/*" so node_modules and
  // dist are never scanned.
  content: [
    './index.html',
    './*.{ts,tsx}',
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './services/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
