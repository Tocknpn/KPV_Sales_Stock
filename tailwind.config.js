/** @type {import('tailwindcss').Config} */
export default {
  content: ["./public/**/*.html", "./public/js/**/*.js"],
  darkMode: "media",
  theme: {
    extend: {
      fontFamily: {
        sans: ["Plus Jakarta Sans", "Noto Sans Lao", "sans-serif"],
        lao: ["Noto Sans Lao", "Plus Jakarta Sans", "sans-serif"],
      },
      colors: {
        // HSL(0, 100%, L) ramp anchored at 600 = the brand hex #990000
        // (maroon mood, replacing the old amber brand) — see
        // .impeccable/surfaces/public-index-html.md for the direction
        // contract and PRODUCT.md for the confirmed brand commitment.
        brand: {
          50: "#ffebeb",
          100: "#ffd1d1",
          200: "#ffa3a3",
          300: "#ff6666",
          400: "#ff1a1a",
          500: "#d60000",
          600: "#990000",
          700: "#7a0000",
          800: "#5c0000",
          900: "#420000",
        },
        // DEFAULT is the text-safe (WCAG AA, >=4.5:1 on white) shade, since
        // every text-success/-warning/-danger usage in this app colors real
        // text (stock deltas, status labels) or white toast text on top of
        // it. Raw vibrant hexes for non-text fills (chart bars, dots) are
        // kept separately as literal hex in charts.js/util.js, unaffected
        // by this token.
        // danger is a vermillion (H13) deliberately pulled off brand
        // maroon's hue (H0) so "something's wrong" never reads as "just the
        // theme color" — status pills still pair it with a label/icon too.
        success: { DEFAULT: "#047857", bg: "#ecfdf5" },
        warning: { DEFAULT: "#92400e", bg: "#fffbeb" },
        danger: { DEFAULT: "#c0330c", bg: "#fdf0ed" },
        canvas: "#fdf4f3",
        surface: "#ffffff",
        hairline: "#e5e7eb",
      },
      boxShadow: {
        card: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)",
        pop: "0 8px 24px rgba(153,0,0,0.14)",
      },
      borderRadius: {
        xl2: "1.25rem",
      },
    },
  },
  plugins: [],
};
