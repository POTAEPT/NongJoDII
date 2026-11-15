# Plan: #19 Clarity funnel

Issue: https://github.com/POTAEPT/NongJoDII/issues/19
Status: blocked by #18 Dashboard screen. PR #68 (branch `17-18-dashboard`) is open. The Clarity tag is already in `main` (PR #27).
Estimate: about 1 hour after PR #68 merges.

## Goal

Clarity records which Dashboard sections users reach, as course evidence.

## Steps

1. After PR #68 merges, merge `origin/development` into this branch.
2. Add a small client helper, for example `src/app/clarity-event.ts`, that calls `window.clarity?.("event", name)` and does nothing when Clarity is not loaded (non-production builds).
3. On the Dashboard screen, use an IntersectionObserver on each section and send one event per section per page view, for example `dashboard_section_tasks`.
4. Send no user IDs, group IDs or names. Page text stays masked (`data-clarity-mask="True"` on `<body>`).

## Tests

- A unit test for the helper: no Clarity loaded means no error; one event per section per view.

## Done when

`npm test`, `npx tsc --noEmit` and `npm run lint` pass; PR to `development` with "Refs #19"; events seen in the Clarity project after deploy.
