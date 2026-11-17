---
name: playbook
description: Keep a product's playbook in a Lure workspace — bring its lessons up to date with new verdicts, propose a lesson when two measured hypotheses gave the same result, and retract a lesson that no longer holds. Use when the person says "open the playbook", "what have we learned", "make a lesson", "lure playbook", or a Lure skill says a lesson has a new verdict.
license: MIT
---

# playbook — lessons from verdicts, never from one result

A **lesson** says what a kind of change does on this product's site. It is written down only
after two measured hypotheses of the same kind on different pages gave the same significant
result. It carries the sample of each, the date and the site. A lesson grows stronger when a
hypothesis linked to test it before its verdict agrees with it. It is retracted when one says the
opposite. Talk to the person in their language, and write the lesson's statement and prose in it.

The script: `node "${CLAUDE_PLUGIN_ROOT}/scripts/playbook.mts" <command> --workspace <dir>`, called
`playbook` below. It checks the two-results rule, counts the samples and writes every lesson
header. You never type a number into a lesson, and never edit a lesson header yourself.

## 1. Bring the lessons up to date

Run `playbook sync` first, every time. It walks each active lesson's `tests`:

- a verdict with the lesson's result becomes evidence: the lesson is stronger;
- the opposite significant result retracts the lesson on its own, with the hypothesis and its
  numbers in the reason;
- `no_signal`, `insufficient_history` or an unreliable verdict counts neither way; it goes to
  `not_confirmed`. When those reach the number of pieces of evidence, the lesson is
  `in doubt`;
- an abandoned hypothesis leaves the tests.

Tell the person what changed, in plain words. For a retraction, say which hypothesis
contradicted the lesson and with what effect and interval. For a lesson in doubt, say "this lesson
does not hold up" and ask whether to retract it (§5). The script never retracts on doubt
alone. If sync printed "nothing changed", say so in one line.

Then show `playbook list`: each lesson with its status, evidence, not-confirmed and tests.

## 2. Is there material for a new lesson

Run `playbook candidates`. It lists the measured hypotheses with a significant, reliable verdict
that no lesson holds yet.

The script cannot tell whether two changes are "of one kind"; you and the person decide. Read
each candidate hypothesis file: what changed and why. Look for two or more that:

- made the same kind of change;
- have the same label and the same metric;
- are on different pages.

If there are none, say what is missing, such as "one more gain like this one". Then stop. Do not
stretch two different changes into one lesson to have something to show.

## 3. Propose a lesson

Say the lesson in your own words, in one sentence: what kind of change, and what it does. Then
say where it ends: which pages, which queries, what was not tested. Ask the person whether it is
what they believe too, and change it as they say.

Put it in `<workspace>/.lure/lesson.json` (local, never committed; overwrite it each time):

```json
{
  "slug": "short-kebab-name",
  "statement": "one sentence: this kind of change does this",
  "change_kind": "the kind of change, short",
  "hypotheses": ["<hypothesis id>", "<hypothesis id>"],
  "body": "Your words: what was done, why we think it is general, where the lesson ends."
}
```

The script derives the direction, metric, site, samples and dates from the verdicts. Run
`playbook add --input <workspace>/.lure/lesson.json --dry-run` and show the person the whole file
it prints. If the script refuses, tell them why in plain words; never work around a refusal.
After their yes, run it without `--dry-run`.

## 4. Testing a lesson

A lesson is tested by a hypothesis recorded before its verdict. `/lure:hypothesis` asks whether
a new hypothesis tests a lesson and links it with
`playbook link --lesson <lesson id> --hypothesis <hypothesis id>`. Run that link yourself only
for a hypothesis that is still `planned` or `live`. The script refuses a measured one: linking
after the result would pick results to fit the lesson.

When the person wants to test a lesson, offer `/lure:hypothesis` for a page of the same kind.

## 5. Retract

When the person says a lesson no longer holds, run
`playbook retract --id <lesson id> --reason "<their words>"`. The file stays, with the date and
reason; nothing is deleted.

## 6. Lessons stay with their product

A lesson is about this product's site, and its `site` says so. Never suggest copying a lesson
into another product's workspace, and never read another workspace for lessons. If the person
wants to try the same idea on another product, it starts there as a new hypothesis that they
record themselves.

## 7. Journal and git

The script appends its own lines to `journal.md`. In a workspace that is a git repository, show
the person the diff. After their yes, commit by
[the workspace's Git rule](../init/references/workspace-format.md#git). The files are the lesson
files `playbook/<id>.md` named in the new `playbook:` journal lines, and `journal.md`. Name each
file; never a folder.
