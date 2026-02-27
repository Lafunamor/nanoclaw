---
name: schwarzwasser-reservations
description: Check Schwarzwasser ice rink reservation times for Blackwater-Rangers. Fetches the public reservation list and reports upcoming ice times.
---

# Schwarzwasser Reservation Checker

Check upcoming reservation times for Blackwater-Rangers at Eisbahn Schwarzwasser.

## When invoked as a skill

Run the check script and report the results:

```bash
bash .claude/skills/schwarzwasser-reservations/check.sh
```

Then report the results to the user in natural language.

## Quick check from terminal

```bash
# Check Blackwater-Rangers (default)
bash .claude/skills/schwarzwasser-reservations/check.sh

# Check a different team
bash .claude/skills/schwarzwasser-reservations/check.sh "Other Team Name"
```

## WhatsApp agent usage

The container skill is available at `container/skills/schwarzwasser-reservations/SKILL.md` and is automatically synced to every container. From WhatsApp, ask the agent:

> "Check when Blackwater-Rangers have their next ice time"

The agent will use the `schwarzwasser-reservations` skill (via curl + node inside the container).

## Data source

URL: https://irs.indico.ch/schwarzwasser/views/ReservationList?location=Schwarzwasser
Public page, no authentication required.
Columns: Date | Time | Entity | Team | Info
