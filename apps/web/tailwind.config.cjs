/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        // expose --ls-* tokens as Tailwind colors for arbitrary value escape hatches
        'ls-bg': 'var(--ls-bg)',
        'ls-bg-subtle': 'var(--ls-bg-subtle)',
        'ls-panel': 'var(--ls-panel)',
        'ls-border': 'var(--ls-border)',
        'ls-border-strong': 'var(--ls-border-strong)',
        'ls-text': 'var(--ls-text)',
        'ls-text-secondary': 'var(--ls-text-secondary)',
        'ls-text-tertiary': 'var(--ls-text-tertiary)',
        'ls-structure': 'var(--ls-structure)',
        'ls-hypothesis': 'var(--ls-hypothesis)',
        'ls-corroborated': 'var(--ls-corroborated)',
        'ls-risk': 'var(--ls-risk)',
        'ls-link': 'var(--ls-link)',
        'ls-hyp-tint': 'var(--ls-hyp-tint)',
        'ls-grn-tint': 'var(--ls-grn-tint)',
      },
      fontFamily: {
        sans: [
          'Geist',
          '"Hiragino Sans GB"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          '"Noto Sans SC"',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'sans-serif',
        ],
      },
      borderRadius: {
        'ls-card': 'var(--ls-radius-card)',
        'ls-control': 'var(--ls-radius-control)',
        'ls-panel': 'var(--ls-radius-panel)',
        'ls-pill': 'var(--ls-radius-pill)',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
