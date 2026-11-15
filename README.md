# Lure

Lure is a framework for promoting a product with AI agents — search visibility of its website
and posts on the channels its audience reads. Agents research, plan and draft; you approve
whatever goes public; weeks later Lure measures what each change did and keeps the lesson for
the next round.

**Status: design.** There is no code yet. The specification is being written in
`.ai/specs/`; until it is, nothing here can be installed or run.

## The idea

Most AI marketing tools stop at "published". Lure treats every change — a new page, a rewritten
title, a post — as a hypothesis: it records what changed and when, measures it against a
baseline once the data has had time to arrive, and writes the result into the product's
playbook, so the next plan starts from what worked rather than from scratch.

What it is meant to hold to:

- **You approve what goes public.** Each channel has its own publishing mode — published
  through the platform's official API, proposed as a change, drafted for you, or found and
  left for you to answer — and no mode goes past what the platform's own rules allow.
- **One tool, many products.** Each product has its own workspace: profile, audience, voice,
  channels, plan, history and playbook. A company website and a side project are configured
  apart.
- **Plain local files.** A workspace is a folder. Git is not required; when the folder is a
  git repository, Lure commits its own changes.
- **Runs on your machine**, for people who are not developers too: the installer brings its own
  runtime.

## How it is built

Lure is developed with [Jig](https://jig.fapost.in): its knowledge lives in `.ai/knowledge/`,
and work goes through Jig tasks and pull requests.
