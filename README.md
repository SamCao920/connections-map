# Connections Map

A private map of the people you know, so that when you visit a city you remember who lives there and can reach out for coffee.

- Pin each connection to a city, with where you met, tags, and how to reach them.
- **Meeting log:** record each coffee or call with a date, where, and what you talked about. The list shows when you last met.
- **Expiry:** give a connection an end date (“until March 2027”) or a duration (“for 4 years”). After that they turn grey: you are no longer sure they still live there.
- **Who’s near:** type a city and a radius to list everyone within range, current people first.
- Works on phone and laptop.

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
      "place": { "label": "Berkeley, California, United States", "lat": 37.8715, "lng": -122.273 },
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

`expiresAt` is the first moment the contact counts as expired (`null` for no expiry). Deleted contacts are kept as `{ "id", "deleted": true, "updatedAt" }` so deletions sync across devices.

## Credits

Map: [Leaflet](https://leafletjs.com), tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Place search: [Nominatim](https://nominatim.org).
