# Task for Visual Tools Terminal

## Priority: High

Add **create_gantt_chart** tool to visual-media-tools.js:

1. Open `backend/src/services/agents/visual-media-tools.js`
2. Add new tool: `createGanttChart` — generate a Gantt chart as SVG
   - Parameters: title, tasks[] (label, startDay, durationDays, color, progress), showDependencies
   - Render: horizontal bars with task labels, date headers, dependency arrows
   - Color palette for task bars
   - Legend for progress indicators
3. Add it to `VISUAL_MEDIA_TOOLS` array at the bottom
4. Add manifest entry to `tool-manifest.js` (copy pattern from other tools)
5. Add 2 test cases to `backend/tests/visual-media-tools.test.js`
6. TEST: `npm test` in backend/
7. PUSH: `git add -A && git commit -m "feat(visual-media-tools): add create_gantt_chart tool" && git push sira-org main`
