# VIT-CampusMap

A map of VIT Vellore with the things students look for: hostels, canteens, 
cycle stands, ATMs, printing, opening hours, and one fast search over all of it.

## The one rule

**Real data or no data.** Every fact in this repo traces to a public source.
Where no source exists the feature is simply absent, rather than guessed at.

## Sources

| What | Where from | Count |
|---|---|---|
| Places, geometry, opening hours, wheelchair tags | [OpenStreetMap](https://www.openstreetmap.org/relation/15931944) (ODbL) | 119 places, 118 buildings |
| Campus boundary | OpenStreetMap via Nominatim (two disjoint plots) | 2 polygons |
| Paths and roads | OpenStreetMap highways | 45 paths, 71 roads |
| Walking/cycling network | Same highways, turned into a routing graph | 424 nodes, 469 edges |

Category coverage depends entirely on what is tagged in OpenStreetMap for
our campus. Hence, we need people like you to tag places on the map to 
make it more useful for everyone.

## Running it

```bash
npm install
npm run fetch      # OpenStreetMap via Nominatim + Overpass, cached, use --force to refetch
npm run dev
```

```bash
npm test           # typecheck + rebuild data + smoke test
npm run verify      # load it in a real headless Chrome and assert it works
```

`npm run verify` drives a throwaway Chrome profile against a running dev
server and fails on any console error, failed request, missing map label, or
overlapping UI.

## Contributing

**See something missing on the map?** Right-click the spot (long-press on
mobile), or open the About panel and hit "Mark a location." Either way it
opens a ready-to-file GitHub issue with the coordinates already filled in,
no account setup or JSON editing required. A faster, in-app way to submit
these reports is in the works, so this GitHub detour won't be needed for
much longer.

Prefer to map it yourself? Add it directly to
[OpenStreetMap](https://www.openstreetmap.org/relation/15931944) and this
picks it up on the next `npm run fetch`, along with every other OSM
consumer. Most of the physical world (printers, cycle stands, opening
hours, step-free access) belongs there rather than in this repo.

For the rare case OSM genuinely will not take (a one-off with no tag to
hang off), it goes in `data/curated/places.json` instead: either surveyed
`lat`/`lon`, or an `anchor` naming a real OSM feature to sit beside, in
which case the build resolves the position and warns if that anchor stops
matching.

## Licence

Code [MIT](LICENSE). Map data (c) OpenStreetMap contributors,
[ODbL](https://www.openstreetmap.org/copyright). Type is Departure Mono (OFL 1.1).
