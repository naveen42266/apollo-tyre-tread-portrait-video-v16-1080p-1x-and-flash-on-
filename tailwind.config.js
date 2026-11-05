/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        montserrat: ['Montserrat', 'sans-serif'],
      },
      colors: {
        primary: '#DCE8F5',
        secondary: '#457B9D',
        hoverSecondary: '#589cc7'
      },
    },
  },
  plugins: [],
}