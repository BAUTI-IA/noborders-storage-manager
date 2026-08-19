/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: "var(--brand)", dark: "var(--brand-dark)" },
        navy: "var(--navy)",
        pos: "var(--green)",
        warn: "var(--amber)",
        neg: "var(--red)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        line: "var(--line)",
        canvas: "var(--bg)",
        card: "var(--card)",
      },
      borderRadius: { DEFAULT: "var(--radius)", md: "var(--radius)" },
      fontSize: {
        "2xs": ["10px", "14px"],
        xs: ["11px", "15px"],
        sm: ["12px", "17px"],
        base: ["13px", "18px"],
        lg: ["15px", "21px"],
        xl: ["18px", "24px"],
        "2xl": ["22px", "28px"],
        "3xl": ["28px", "34px"],
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
      },
    },
  },
  plugins: [],
};
