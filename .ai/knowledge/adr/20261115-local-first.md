---
id: adr-20261115-local-first
type: adr
status: accepted
date: 2026-11-15
domains: []
paths: []
summary: Lure runs on the person's machine, schedule included; no hosted service
---
# Lure runs on the person's machine; there is no hosted service

## Context

Product data includes an employer's Search Console data. The audience already pays for an agent
runtime and should not need another account. Spec `lure`, Decisions.

## Decision

Lure runs on the person's machine, scheduled runs included (the desktop app's scheduled tasks
or cron with a headless agent run). Missed runs are caught up at the next start. Notifications
reach the person through a Telegram bot, with a desktop notification as fallback. Lure has no
server, no account and no telemetry.

## Alternatives

- Cloud routines for the schedule — rejected: the product's Search Console access would have to
  live in the cloud.
- A hosted service — rejected: data leaves the machine; an account and a subscription on top of
  the runtime.

## Consequences

- Checks happen only while the machine is on; a weekly cadence tolerates gaps, and overdue
  checks must be visible.
- Credentials (Search Console, Telegram, platforms) stay on the machine and never in the engine
  repository; where exactly on the machine is not decided yet.
