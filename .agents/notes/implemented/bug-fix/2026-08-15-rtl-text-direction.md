# Agent Note: Majority-script text direction for RTL message rendering

Status: implemented

English | [中文](2026-08-15-rtl-text-direction.zh.md)

## Problem

No element in the web client set a `dir` attribute, so a message's base
direction fell to the browser default: LTR. For mixed-script text that is
mostly Arabic but opens with a Latin word (e.g. `Hello كيف حالك اليوم`), the
browser's `dir="auto"` first-strong rule (UAX #9 P2/P3) also resolves LTR,
scrambling the Arabic word order and making the sentence unreadable. The
defect was reported as issue #20.

## Decision

`textDirection(text)` in `packages/client/ui-primitives/src/markdown/text-direction.ts`
classifies a run's base direction by counting strong RTL and LTR script code
points and letting the majority win. It deliberately differs from the
browser's first-strong heuristic so that a sentence opening with a Latin word
followed by Arabic stays RTL, while a Latin sentence with an occasional Arabic
token stays LTR. Neutral-only and empty input resolve LTR.

The result is applied as an explicit `dir` attribute:

- `MessageText` (user and steering literal text) on its container.
- `MarkdownText` on its container and, per block, on `paragraph` and `heading`
  nodes in `render.tsx`, so a single reply can mix RTL prose with LTR code
  blocks and tables.
- The `InputBar` draft surface and the `QuestionComposer` question title and
  custom-answer fields.

## Alternatives considered

- **Relying on the browser's `dir="auto"`.** First-strong misclassifies the
  exact case reported — a leading Latin word followed by Arabic — and is the
  behavior the report names as the cause.
- **Setting direction only on the markdown container.** Correct for a
  single-paragraph reply but wrong for mixed replies: an RTL container would
  pull code blocks and tables into an RTL base direction, and it could not let
  one paragraph be RTL while another is LTR.
- **A full Unicode bidi implementation.** Reproducing UAX #9 P2/P3 exactly
  would reinstall the misbehaving first-strong heuristic rather than fix it;
  majority script counting is a small, testable heuristic that targets the
  reported failure.

## Consequences

RTL-dominant messages render right-to-left at the message, paragraph, and
input surfaces. Code blocks and tables inside an RTL reply keep their natural
LTR base because their strong Latin content still renders LTR under the bidi
algorithm, and per-block `dir` overrides the container for mixed replies. A
streaming message whose direction flips as more text arrives can reflow
mid-stream; that is inherent to content-derived direction and settles once the
message completes. Scripts outside the enumerated RTL and LTR sets (Arabic,
Hebrew, Syriac, Thaana, N'Ko versus Latin, Greek, Cyrillic, Armenian) are
neutral and do not vote.

## Testing

`text-direction` unit tests in `markdown.client.spec.tsx` cover RTL-dominant
text with a leading Latin word, LTR-dominant text, a Latin sentence with an
Arabic token, neutral-only and empty input, and a tie. `markdown-render-units.client.spec.tsx`
pins per-paragraph and heading `dir` and the `inlineText` extraction through
emphasis, links, inline code, and image alt (including a missing alt).
`input-bar.client.spec.tsx` and `user-questions-composer.client.spec.tsx` pin
the input and composer surfaces.
