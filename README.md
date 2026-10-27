# Connections Map

A private map of the people you know, so that when you visit a city you remember who lives there and can reach out for coffee.

- Pin each connection to a city, with where you met, tags, and how to reach them. A connection can have **several places** (one pin each, for someone who splits their time) or **none** (someone you only email; they show in the list as “No location”).
- **Meeting log:** record each coffee or call with a date, where, and what you talked about. The list shows when you last met.
- **Expiry:** give a connection an end date (“until March 2027”) or a duration (“for 4 years”). After that they turn grey: you are no longer sure they still live there.
- **Who’s near:** type a city and a radius to list everyone within range, current people first.
- **Trip alerts:** an optional daily task reads travel bookings from your email and calendar, writes them to `trips.json` in your data repo, and notifies you who lives near each destination. Upcoming trips show as cards at the top of the list.
- **Expiry check-ins:** a month before someone expires, a card asks whether they’re still there (extend a year, mark moved, or remove).
- **Statistics:** the chart button shows totals, top cities and countries, farthest-apart pair, meeting counts, who you haven’t seen in a year, where you met people, tags, and expiries by year.
- **Collapsible tags:** fold the tag list away; the choice is remembered, and active filters stay visible in the heading.
- **Import from Apple Contacts:** load a vCard export and tick who to add; addresses are placed on the map.
- Light and dark mode, frosted-glass interface, works on phone and laptop.

## Where your data lives

The site is a static page. Your contacts are **not** in this repo.

- **Browser only (default):** contacts stay in the browser you’re using.
- **Private GitHub repo (recommended):** contacts are saved as one JSON file in a private repo you own and sync across devices.

To set up sync:

1. Create a private repo, e.g. `connections-data`.
2. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token. Repository access: only that repo. Permissions: Contents, Read and write.
3. Open the site → settings (gear) → enter `your-username/connections-data` and the token → Connect.

The token is stored only in your browser and sent only to `api.github.com`. Anyone can use this site with their own repo; nobody can see anyone else’s data.

## Data format

`contacts.json`:

```json
{
  "version": 1,
  "updatedAt": "2026-10-15T19:00:00.000Z",
  "contacts": [
    {
      "id": "uuid",
      "name": "Alice Chen",
      "places": [{ "label": "Berkeley, California, United States", "lat": 37.8715, "lng": -122.273 }],
      "met": "Making Progress, Oct 2026",
      "tags": ["making progress"],
      "reach": "alice@example.com",
      "meetings": [
        { "id": "uuid", "date": "2026-10-11", "where": "Making Progress, Berkeley", "note": "Talked about housing policy" }
      ],
      "addedAt": "2026-10-15T19:00:00.000Z",
      "expiresAt": "2030-10-15T19:00:00.000Z",
      "updatedAt": "2026-10-15T19:00:00.000Z"
    }
  ]
}
```

`places` can hold any number of entries, including none. Older files with a single `place` still load and are converted when you next save.

`expiresAt` is the first moment the contact counts as expired (`null` for no expiry). Deleted contacts are kept as `{ "id", "deleted": true, "updatedAt" }` so deletions sync across devices.

## Credits

Map: [Leaflet](https://leafletjs.com), tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Place search: [Nominatim](https://nominatim.org).
