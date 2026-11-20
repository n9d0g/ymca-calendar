# Scrape VirtuaGym's public schedule pages instead of using its API

The McDonald Centre's schedule lives in VirtuaGym (club `90765`). VirtuaGym's official API (`api.virtuagym.com`) needs an API key and club secret that only the YMCA can issue, so we read the public, unauthenticated embed pages the YMCA website itself iframes. That means one week page per Category (`/classes/week/<date>?event_type=N&embedded=1&pref_club=90765`), plus one detail page per Session (`/classes/class/<id>?...`), because the Room only appears on the detail page. robots.txt doesn't disallow `/classes/` for general crawlers, but this is unofficial and breaks whenever VirtuaGym changes its markup.

## Considered Options

- **VirtuaGym API**: the stable, sanctioned route, but we have no key. Revisit if the YMCA ever grants one.
- **ymcaschedule.ca**: an unofficial reformatter of the same pages. It has no feed or API, and no Room data.

## Consequences

- A markup change silently yields zero or malformed Sessions. The build therefore refuses to publish when a Category finds no Sessions for the current week, and alerts instead. The exception is Community and Leadership, which has never had any Sessions on VirtuaGym. It may publish empty, and the other four Categories still catch a markup change, since one would empty all of them.
- To keep request volume low, we cache detail pages by Session ID and only publish the current week plus the next two.
