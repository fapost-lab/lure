# Measurement rules for recording a hypothesis

These numbers are starting assumptions. The first verdicts will show whether they hold, and the
check may revise them; a change here is a change to Lure, reviewed like any other.

## The window

28 days, ending on the last final day in the workspace's Search Console history. Four whole
weeks, so weekdays and weekends weigh the same, and the length Search Console's own reports use.

## Primary metric and traffic floor

Decide from the page's numbers in the window (`window`):

| The page has | Primary | Secondary | Floor |
| --- | --- | --- | --- |
| 50 clicks or more | `clicks` up | `impressions` up | `measurable` |
| fewer clicks, 300 impressions or more, rows on 21 days or more | `impressions` up | `position` down | `measurable` |
| fewer clicks, 100–299 impressions, or rows on fewer than 21 days | `impressions` up | `position` down | `weak` |
| under 100 impressions | as above | as above | `below` |

`position` down means better: a smaller number is higher on the page of results.

**Why position is never primary below the click floor.** Average position follows the mix of
queries a page appears for. A rewrite that starts appearing for new, distant queries lowers the
average while the page gains reach; so position is shown, never decisive.

**Rows on few days** usually means the page only just came back to the index; its baseline is
not representative. Say so in `floor_reason`.

Write `floor_reason` with the numbers: impressions, clicks, days with rows.

## Control pages

Two or three pages that stay untouched while the hypothesis runs, so that what moved the whole
site is not credited to the change:

- the same kind of page as the target — the same template, so site-wide changes and seasonality
  move them alike;
- impressions of the same order as the target's, and at least `weak` by the table above;
- not the page of an active hypothesis (`busy`); a page may be a control of several hypotheses;
- no event of their own in the window.

Say why each was chosen. Pages of one template are often linked to each other in navigation, so
a change to one can move the others; the check shows each control on its own, not only their
average.

## Seasonality

Search demand moves by month. Controls carry the season; the target's own rise or fall means
nothing until it is compared with them.
