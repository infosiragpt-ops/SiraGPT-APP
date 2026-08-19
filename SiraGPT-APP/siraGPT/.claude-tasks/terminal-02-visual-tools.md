# Task for Visual Tools Terminal

## Build: create_network_diagram SVG tool

Add a new tool `create_network_diagram` to `backend/src/services/agents/visual-media-tools.js`:

- Generates an SVG network/topology diagram: nodes (server, database, firewall, cloud, user, api) connected by lines
- Parameters: title, nodes[] (id, label, type, x?, y?), connections[] (from, to, label?, style?)
- Auto-layout if x/y not specified (circle or layered)
- Color-coded node types
- Add to VISUAL_MEDIA_TOOLS array
- Add manifest entry in tool-manifest.js
- Add 2 test cases in visual-media-tools.test.js

Then: `npm test && git add -A && git commit -m "feat(visual-media-tools): add create_network_diagram tool" && git push sira-org main`
