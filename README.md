# Silver Local Setup (Postgres)

## API

- `GET /api/health`
- `GET /api/premium-config`
- `GET /api/serials/summary`
- `GET /api/mints/:walletAddress`
- `POST /api/mints/:walletAddress`
- `POST /api/admin/login`
- `POST /api/admin/logout`
- `GET /api/admin/premium-config` (auth required)
- `POST /api/admin/premium-config` (auth required)
- `GET /api/admin/serials` (auth required)
- `POST /api/admin/serials` (auth required)
- `GET /api/admin/mints` (auth required)

Mint history is now stored in Postgres when API/DB is available. Frontend localStorage is still used as fallback cache.

## Admin Panel

Use the admin panel to update:

- Percent premium (decimal, e.g. `0.04` = 4%)
- Fixed AUD add-on (e.g. `4.00`)
- Serial inventory (11-digit serials, one per line)

Default serial seed:

- On first startup with empty `serial_inventory`, the app seeds `00000000001` to `00000000100`.
- Mint allocation is sequential from the next available serial.
