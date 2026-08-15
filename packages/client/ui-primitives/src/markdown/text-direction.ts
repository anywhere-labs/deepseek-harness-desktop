/**
 * Base-direction detection for the `dir` attribute on user-visible text.
 *
 * Counts strong LTR and RTL script code points and lets the majority win.
 * This deliberately differs from the browser's `dir="auto"` first-strong
 * heuristic (UAX #9 P2/P3), which resolves a sentence that opens with a Latin
 * word followed by Arabic (e.g. `Hello كيف حالك اليوم`) to LTR and scrambles
 * the Arabic word order. Majority counting keeps that sentence RTL while a
 * genuinely Latin sentence with an occasional Arabic token stays LTR.
 *
 * The scripts below cover the strong alphabetic scripts the product renders;
 * digits, punctuation, symbols, and unlisted scripts are neutral and do not
 * vote. Persian, Urdu, and other Arabic-script languages vote through the
 * Arabic script.
 */

/** Strong right-to-left scripts. */
const RTL = new RegExp([
  '\\p{Script_Extensions=Arabic}',
  '\\p{Script_Extensions=Hebrew}',
  '\\p{Script_Extensions=Syriac}',
  '\\p{Script_Extensions=Thaana}',
  '\\p{Script_Extensions=Nko}',
].join('|'), 'u')

/** Strong left-to-right scripts. */
const LTR = new RegExp([
  '\\p{Script_Extensions=Latin}',
  '\\p{Script_Extensions=Greek}',
  '\\p{Script_Extensions=Cyrillic}',
  '\\p{Script_Extensions=Armenian}',
].join('|'), 'u')

/** The base direction a {@link textDirection} result assigns to an element. */
export type TextDirection = 'rtl' | 'ltr'

/**
 * Classify the base direction of a text run.
 * @param text - The text to inspect; neutral-only and empty input resolve to `ltr`.
 * @returns `rtl` when strong RTL code points outnumber strong LTR ones, else `ltr`.
 */
export function textDirection(text: string): TextDirection {
  let rtl = 0
  let ltr = 0
  for (const char of text) {
    if (RTL.test(char)) rtl += 1
    else if (LTR.test(char)) ltr += 1
  }
  return rtl > ltr ? 'rtl' : 'ltr'
}
