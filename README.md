# Chatapp

1. `npm install`
2. `npm start`
3. Open http://localhost:8080 in two tabs. In the first, enter a name and click **Create a new room**. Copy the room code from the header, then in the second tab enter another name and the code and click **Join room**.

Settings (environment variables): `ROOM_CAPACITY` (people per room, default 10; use 2 for strict pairs), `PORT`, `HOST`, `ALLOWED_ORIGINS` (comma-separated, must match the
address in the browser), `ANNOUNCEMENT`.

To use it on a real domain: serve it over HTTPS (reverse proxy), set `HOST=0.0.0.0` and
`ALLOWED_ORIGINS=https://your-domain.com`.
