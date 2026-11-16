# Reading a verdict

These rules are starting assumptions. They are written down before any result, so they cannot
be tuned to one. Changing them changes Lure, and is reviewed like any other change.

## The windows

- **Before:** 28 days ending the day before `live_on`.
- **After:** 28 days starting 7 days after the later of `live_on` and `crawled_on`. The 7 days
  give Google time to re-rank the page.
- `check_on` is the after-window's end plus 3 days, for Search Console's lag.

Both windows are four whole weeks, so weekdays and weekends weigh the same.

## The estimate

P is the target page's primary metric summed over a window; C is the same for its controls.

- Δ = ln(P_after / C_after) − ln(P_before / C_before)
- effect = e^Δ − 1

The effect is the change of the page relative to its controls. A zero sum counts as 0.5.

## How sure

The same pair of windows is slid back through the page's history in steps of 7 days. These
earlier periods had no change in them. They are called placebo windows.

- **Interval.** The 90% interval is Δ plus or minus the 90th percentile of |Δ| over those
  windows.
- **`past`.** "k of M": in k of M earlier periods the page moved this much against its
  controls with no change at all. `effective_windows` counts how many of them do not overlap.
- **`mde`.** Below this size, a change cannot be told from ordinary noise on this page.

Windows touching an `(outage)` line of `events.md` are left out.

## The label

| Label | When |
| --- | --- |
| `noticeable_gain` | the whole interval is on the expected side of zero |
| `worse` | the whole interval is on the other side |
| `no_signal` | the interval crosses zero |
| `insufficient_history` | fewer than 182 days of data before `live_on`, or fewer than 5 placebo windows |

A page with `floor: below` gets `unreliable: true`. Say that its label means little.

## Beside the label

- **`per_control`.** Each control against the other controls. A control that moved on its own
  makes the main effect suspect; name it.
- **`position`.** Before and after, weighted by impressions, for description only. A page that
  gains new distant queries looks lower while it grows.
- **`clicks`.** The same estimate on clicks, only when the page has 30 clicks or more in each
  window. Otherwise it reads `not_enough_clicks`.
- **`updates`.** Google ranking updates that overlap either window.
- **`events`.** Other lines of `events.md` that overlap either window. Either one makes the
  result less certain; say which one and when.

## How to say it

> Impressions +18% against the controls (90%: −9% … +52%); 56 days, 3,360 impressions of the
> page. A shift this large happened in 9 of 40 earlier periods. No signal. The November 2026
> core update was rolling out in the before-window.

Never "90% sure it worked". Never "it worked" without the interval.
