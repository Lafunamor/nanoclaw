---
name: schwarzwasser-reservations
description: Check upcoming ice rink reservation times for Blackwater-Rangers at Eisbahn Schwarzwasser. Use when asked about hockey training, ice time, or Schwarzwasser reservations.
allowed-tools: Bash
---

# Schwarzwasser Reservation Checker

Check upcoming reservations for Blackwater-Rangers at Eisbahn Schwarzwasser.

## How to check reservations

Run this command (curl and node are available in the container):

```bash
curl -s --max-time 15 "https://irs.indico.ch/schwarzwasser/views/ReservationList?location=Schwarzwasser" | node -e "
const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  const html = chunks.join('');
  const team = 'Blackwater-Rangers';
  const rows = html.match(/DXDataRow\d+[\s\S]*?<\/tr>/g) || [];
  const results = [];
  for (const row of rows) {
    const cells = (row.match(/<font size=\"3\">([\s\S]*?)<\/font>/g) || [])
      .map(c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim());
    if (cells[3] === team) {
      results.push({ date: cells[0], time: cells[1], info: cells[4] || '' });
    }
  }
  if (results.length === 0) {
    console.log('No upcoming reservations found for ' + team + '.');
  } else {
    console.log('Reservations for ' + team + ':');
    for (const r of results) {
      const info = r.info ? ' (' + r.info + ')' : '';
      console.log(r.date + '  ' + r.time + info);
    }
  }
});
"
```

## After running

Report the results to the user in natural language. For example:
- "Blackwater-Rangers have ice time on 21.02.2026 from 08:00–09:15 (Hockeytraining)."
- "No upcoming reservations are listed for Blackwater-Rangers right now."

## Notes

- The page shows reservations for the current/upcoming period (no date filter needed for today's check)
- Columns parsed: Date | Time | Entity | Team | Info
- Source: https://irs.indico.ch/schwarzwasser/views/ReservationList?location=Schwarzwasser
