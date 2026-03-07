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
- `GET /api/mints/:walletAddress`
- `POST /api/mints/:walletAddress`

Mint history is now stored in Postgres when API/DB is available. Frontend localStorage is still used as fallback cache.
