# Conexiones / Apps logos

Official brand marks used by the Apps catalog on `/conexiones` and `/gpts`.

Most files are [Simple Icons](https://simpleicons.org/) SVGs (CC0 1.0).
A few well-known marks (Google G, Gmail envelope, Microsoft squares) are
compact geometric reconstructions using publicly documented brand colors.

`brand/` bundles real domain marks (site favicons, ≥32px, PNG/JPEG) for the
long tail of catalog apps that have no Simple Icons mark — so every real
host shows its actual logo instead of a monogram tile. They are fetched
once from the site's public favicon and stored locally; never hot-linked
at runtime. Apps with invented/nonexistent domains keep the generated
monogram tile fallback in `lib/gpts-app-logos.ts`.

Do not add scraped trademarked raster dumps beyond this policy. Prefer
Simple Icons or the local `brand/` bundle; avoid runtime favicon CDNs
(Clearbit / Google s2 / DuckDuckGo ip3) which are blurry or flaky.
