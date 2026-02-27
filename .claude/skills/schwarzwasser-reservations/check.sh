#!/bin/bash
# Check Schwarzwasser ice rink reservations for Blackwater-Rangers
# Usage: ./check.sh [team-name]
# Default team: Blackwater-Rangers

TEAM="${1:-Blackwater-Rangers}"
URL="https://irs.indico.ch/schwarzwasser/views/ReservationList?location=Schwarzwasser"

curl -s --max-time 15 "$URL" | TEAM="$TEAM" node -e "
const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  const html = chunks.join('');
  const team = process.env.TEAM;
  const rows = html.match(/DXDataRow\d+[\s\S]*?<\/tr>/g) || [];
  const results = [];

  for (const row of rows) {
    const cells = (row.match(/<font size=\"3\">([\s\S]*?)<\/font>/g) || [])
      .map(c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim());
    // cells: [date, time, entity, teamName, info]
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
      console.log('  ' + r.date + '  ' + r.time + info);
    }
  }
});
"
