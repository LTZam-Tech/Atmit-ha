/**
 * Reusable negative / boundary values. Pick from here instead of inventing them per test,
 * so every form in the system is attacked with the same proven set.
 */
export const Negative = {
  empty: '',
  whitespace: '   ',
  sqlInjection: "' OR '1'='1' --",
  xss: '<script>alert(1)</script>',
  htmlTag: '<b>bold</b>',
  unicode: 'ñ漢字🙂',
  arabic: 'مستخدم_تجريبي',
  rtlMixed: 'user_مستخدم_123',
  longText: (length = 256) => 'a'.repeat(length),
  specialChars: '!@#$%^&*()_+{}|:"<>?',
  leadingTrailingSpaces: (v: string) => `  ${v}  `,
  upperCase: (v: string) => v.toUpperCase(),
} as const;

/** Boundary helpers for length-limited fields */
export const boundary = (min: number, max: number) => ({
  belowMin: 'x'.repeat(Math.max(0, min - 1)),
  atMin: 'x'.repeat(min),
  atMax: 'x'.repeat(max),
  aboveMax: 'x'.repeat(max + 1),
});
