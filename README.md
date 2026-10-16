# Three-site browser QA

Public, logged-out desktop Chromium and touch-emulated mobile QA for pl168.net,
jf1688.com.tw and firstloan.tw. This repository does not deploy website changes.

## Run

```
npm ci
npx playwright install --with-deps chromium --only-shell
npm run test:engine
QA_SCOPE=full npm run prepare:qa
npm test
npm run report:qa
```

`Daily Three-Site QA` supports `full` (sitemaps plus same-site HTML link closure)
and `smoke` (homepages). The inventory is fixed before browser testing. A URL
discovered only by browser interaction is reported as a coverage gap, never as a
successful full run. Search-result combinations, tracking links, login routes,
feeds and binary files are not crawled as separate HTML pages; their visible
links are still interacted with where applicable.

Every URL is its own isolated Playwright test, assigned to exactly one shard per
device. The same header/button on different pages is clicked separately.
Desktop links use real Ctrl-click/new-tab navigation; mobile uses real touch
taps and browser Back. Scrolling, hovering, clicks and input steps are paced at
least three seconds apart. Differential discovery tests children of menus,
submenus, accordions, slides and lightboxes without recursively adding all
existing links. Revealed-control replay and a failed action's one retry start
from a clean document. Failed actions are saved and testing continues.

Each page audit starts with a fresh context and live resources. While clicking
within that page, a bounded asset cache honors the live server's public max-age
headers, restoring ordinary visitor caching that request interception disables.
Documents, APIs, errors, private/no-cache resources and submissions are never
served from this cache. Cache contents do not carry over to another page test.

Telephone/mail handoffs and outgoing form/message/voting requests are prevented
in the test browser. Those controls are physically clicked and separately marked
`interaction_only`, rather than claiming a backend submission or native app
passed. Authentication, disabled controls and CAPTCHA challenges are explicitly
listed as excluded. Native iOS Safari and authenticated user journeys are not
included. The browser instrumentation is not installed on the three websites.

## Evidence and coverage gate

`qa-results/<site>/<device>/<URL hash>.json` is atomically saved before every
action, after every finding and after every action. Timeout/crash reports retain
the last action. Each shard uploads checkpoints with `if: always()`. The final
job builds `qa-combined-results`, containing:

- `qa-report/coverage-summary.json`: exact six-group coverage and result;
- `qa-report/click-audit.txt`: every control, selector, real click count/outcome;
- `qa-report/qa-errors.txt`: website failures and untested coverage;
- `qa-report/qa-warnings.txt`: third-party/background warnings;
- `qa-report/daily-report.md`: Traditional Chinese summary;
- `qa-manifest/`: frozen inventory and crawl metadata;
- `qa-results/`: complete and partial browser checkpoints.

The gate fails for a missing/incomplete page, undiscovered inventory coverage,
failed control, same-site HTTP/resource failure, page JavaScript error, broken
image, empty title or horizontal overflow. Storage-access warnings, report-only
CSP and third-party resource failures remain `QA_WARNING`. Script-order errors
such as `jQuery is not defined` are not suppressed.

An interrupted run may be dispatched again with `resume_run_id`. Only complete
passing pages from the identical interaction engine/browser configuration and
three-second pacing are reused for up to 24 hours (original commit/time retained);
failed, missing and interrupted pages are rerun. Browser tests have no action or
page sampling limit. A 45-minute per-page or 5.5-hour runner timeout remains an
explicit incomplete failure with retained checkpoints, never a silent pass.

`inventory_run_id` can reuse an immutable complete manifest from the preceding
24 hours when repairing the QA engine. Its original collection timestamp is
retained. This avoids repeating the sitemap/HTML crawl during a same-day fix;
all browser interactions are still rerun for the new commit.

Embedded video overlays and iframe player gestures are included. YouTube/Vimeo
playback is checked for advancing video time, then paused when possible. A player
whose playback cannot be confirmed is explicitly marked `interaction_only` with
`QA_WARNING`; the external provider's account/sharing/purchase interfaces are
outside these three websites' QA scope.

## Engine regression checks

Local fixture pages verify desktop/touch clicks, duplicate hrefs at distinct
locations, hidden/nested menus, modal cleanup, new tabs, readonly POST/protocol
guards, same-origin HTTP failure versus third-party 401, incomplete checkpoints,
device coverage gaps and the production pacing constant. These checks run before
the live rollout and on repository pushes.
