# Integrated browser performance — 2026-10-26

## Scope

The user reported a heavy integrated browser on `/agentes` and requested a real autonomous search test. This change removes reproduced background work and unnecessary transport work while preserving the existing browser UI, quality level, input ownership and login handoff.

## Reproduced causes and corrections

- The browser presentation forced noVNC quality 9 and compression 0, and those settings leaked into desktop mode. Retain the measured lower-latency quality 9/compression 0 profile and restore the connection's original presentation values when leaving browser mode.
- An extra ResizeObserver broadcast a global resize for every screen change, although noVNC already observes its screen. Remove this wrapper observer; the real RFB gate still verifies sizing and pointer alignment.
- The remote chat panel continued polling activity and login handoff while hidden. Pause and abort on hide/unmount; refresh on visibility restoration; reject stale responses. Automatic polling in both parent chat and panel now honors the server's existing live-probe throttle. Explicit user handoff actions remain fresh.
- The text-only chat tool requested a full PNG and discarded it. It now requests observed text/controls only. Direct vision consumers retain validated PNG capture by default and login gating remains before observation.
- Browser inventory attached to and evaluated every background renderer. Retrieve top-level target metadata in one CDP command, keeping a fresh document read and native focus selection for the active tab.

## Local evidence

- Component baseline: 8 hidden requests in 12 seconds; 100 global resize events from 100 observer callbacks; quality/compression 9/0 persisted into desktop mode. After correction: 0 hidden requests, 0 wrapper resize broadcasts, browser 9/0 and restored original desktop values. These are component tests, not a latency benchmark.
- Nine component regressions failed before correction. 77 related component tests and 71 handoff tests passed. Two source-contract tests initially expected the removed observer and an old variable name; updated their assertions while retaining the real sizing and New Tab behavior checks. The 1,049 affected source cases then passed.
- Two backend regressions failed before correction. Navigation, isolation, login handoff, screenshot validity and browser-control suites passed (103 tests including stable ordering and login gating).
- Real Chromium 148, temporary isolated profile, actual CDP, seven alternating samples per variant, first tab focused: 1 tab median 2.959 to 3.412 ms (4 to 5 commands); 10 tabs 15.034 to 2.651 ms (22 to 5); 25 tabs 27.352 to 2.129 ms (52 to 5). Titles, URLs, active tab, history and viewport matched over 42 reads and five reconnects. This measures local inventory only. Native focus discovery can still traverse tabs when the active tab is later in the list.
- The real Chrome experiment exposed target-list ordering changes on tab creation; the final implementation retains stable per-session observed tab order without extra per-tab calls. The final real-Chrome run verified stable order while growing 1 to 10 to 25 tabs, closing three, adding two, and reconnecting five times. A second-context ownership case retained inventory parity.
- Full root suite: 13,676 passed, zero failed or skipped. TypeScript, lint and UI lock verified. No new dependencies, configuration, routes, controls or model changes.

## Real RFB verification

The existing Linux X11 gate compares quality/compression 9/0, 9/1 and 9/2 in five rounds per profile, rotating their order with fresh real noVNC connections. Every sample displays the same local text and raster fixture, receives three clicks and a scroll, and verifies received framebuffer pixels plus page effects. Existing viewport, corner, pointer and restoration checks remain.

CI run 40379746834 completed all 21 checks. Its real RFB results were:

| Compression | Click median / p95 (ms) | Scroll median / p95 (ms) | Median observed server bytes |
| --- | --- | --- | --- |
| 0 | 47.1 / 64.2 | 116.6 / 235.0 | 1,843,347 |
| 1 | 47.2 / 64.3 | 233.4 / 267.6 | 1,133,868 |
| 2 | 47.1 / 96.8 | 233.4 / 266.5 | 1,128,153 |

Levels 1 and 2 reduced traffic but regressed scroll response in this scenario. The final runtime therefore retains compression 0; only restoration of the original desktop presentation settings changes. The independent polling, observation and inventory optimizations remain.

These are loopback measurements on a shared runner, not production WAN latency. Scroll timing measures the first matching received marker, not completion of the entire repaint. Each profile has five scroll samples and fifteen clicks; nearest-rank p95 is the maximum with these small samples. Bytes are observed during the scenario, not a guaranteed page size. The benchmark writes `/tmp/browser-gate-rfb-metrics.json` and screenshot files and retains all measurements in CI logs. Success screenshots are not uploaded by the existing workflow.

## Production boundary

A separate Chrome window was opened on the actual production `/agentes` route. It requires login; the user explicitly chose to continue with the available automatic tests. No saved credentials or browser profiles were read. Until login and the chat-driven scenario complete, do not describe this as a successful autonomous model search in the user's production account. Local CDP and CI RFB tests are distinct evidence.
