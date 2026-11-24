# Publish one Feed per Space, not per Category

People pick a calendar by where they'll be ("what's on in the gyms?"), not by the YMCA's Category, and a Space's Sessions come from several Categories: the gyms alone carry Group Fitness, Adult Recreational Sports, and Child Youth and Family Sessions. So each Feed holds one Space's Sessions across every Category. We still scrape per Category (ADR 0001), so Categories remain the unit of fetching and health checks, while Spaces are the unit of publishing.

## Considered Options

- **One Feed per Category**: what we had. It splits a single place across up to three calendars and mixes unrelated places in one.
- **One Feed per exact Room**: VirtuaGym labels the same gym three ways (Gym 1, Gym 2, Gym 1 and 2) and moves Programs between them, so subscribing to one label silently misses Sessions.
- **Fan out combined Rooms** (a "Gym 1 and 2" Session in both a Gym 1 and a Gym 2 Feed): duplicates the Session for anyone subscribed to both.

## Consequences

- The Category Feed URLs are gone; subscribers had to resubscribe.
- The Spaces, and which Room strings belong to each, are a fixed list. Every Space always gets a Feed, even an empty one, so a quiet Space doesn't 404 its subscribers. A Room string not on the list raises a warning and its Sessions are left out until it's added.
- A Session without a Room is in no Feed. That's usually a detail page that failed to load, and the run after retries it. Online Sessions never have a Room and are left out for good.
- The exception is a Program a Space claims by name: VirtuaGym never gives Pickleball League a Room, but it's played in the gyms, so the Gyms Space lists it. Its events have no location.
- Health checks (hold back on an empty Category, warn when a Category's count halves) stay per Category, where a markup break shows up. A Space going quiet, e.g. the pool closing for maintenance, is legitimate and doesn't alert.
