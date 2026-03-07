# Silver Local Setup (Postgres)

## 1) Install dependencies

```bash
npm install
```

## 2) Configure env

```bash
copy .env.example .env
```

`.env` defaults:

- `PORT=5500`
- `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/silver`
- `ADMIN_USERNAME=admin1223`
- `ADMIN_PASSWORD=K1Um]7f15q_r`
- `DEFAULT_PREMIUM_PERCENT=0.04`
- `DEFAULT_FIXED_AUD=4.0`

## 3) Start Postgres

```bash
docker compose -f docker-compose.postgres.yml up -d
```

## 4) Run app

```bash
npm start
```

Open `http://localhost:5500`.

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

- Login page: `/admin/login`
- Protected panel: `/admin/panel`

Use the admin panel to update:

- Percent premium (decimal, e.g. `0.04` = 4%)
- Fixed AUD add-on (e.g. `4.00`)
- Serial inventory (11-digit serials, one per line)

Default serial seed:

- On first startup with empty `serial_inventory`, the app seeds `00000000001` to `00000000100`.
- Mint allocation is sequential from the next available serial.
