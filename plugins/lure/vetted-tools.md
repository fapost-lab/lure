# Vetted tools

Tools Lure offers to install. Each is pinned: a version moves only through a change to this
file, reviewed like any other change to Lure. Checked on 2026-11-15.

## claude-seo

- For: technical SEO audits, schema, AI-search visibility (GEO), content quality.
- Author: AgriciDaniel — https://github.com/AgriciDaniel/claude-seo
- Licence: MIT. Stars: about 29.7k.
- Runtime: Claude Code.
- Pinned: `v2.6.2`, commit `468ed5b0d9e3249394783710e54abb02837e326b`.
- Marketplace: `AgriciDaniel/claude-seo`, name `agricidaniel-claude-seo`; plugin `claude-seo`.
- Installs: the plugin's skills and agents. Its optional `/seo setup` builds its own Python
  environment and downloads a browser — several hundred megabytes.
- Sends outside: the pages it audits go to the model, as any agent work does. Optional
  extensions call Google APIs (PageSpeed, CrUX, Search Console, GA4) and paid services
  (SE Ranking, Profound) only when the person sets them up with their own keys.
- Note: releases come every few days; this pin goes stale quickly.

## marketingskills

- For: marketing copy, positioning, page and launch writing.
- Author: coreyhaines31 — https://github.com/coreyhaines31/marketingskills
- Licence: MIT. Stars: about 60.6k.
- Runtime: Claude Code (a Codex plugin exists; not verified here).
- Pinned: `v2.14.12`, commit `1f837447b20bb6f0e72d87b80ece1c221c362c7d`.
- Marketplace: `coreyhaines31/marketingskills`, name `marketingskills`; plugin
  `marketing-skills`.
- Installs: its skills (one plugin, per its marketplace entry).
- Sends outside: nothing found beyond the model; its skills were not read one by one.

## Not listed, and why

- openclaw-marketing-skills (LeoYeAI) — its licence differs between GitHub (MIT) and ClawHub
  (MIT-0), it looks like an unattributed copy of marketingskills, it has no releases, and the
  ClawHub catalogue suffered mass poisoning in 2026.
- seranking/seo-skills — needs a paid SE Ranking account and sends data there.
- superseo-skills — versions not checked yet.
