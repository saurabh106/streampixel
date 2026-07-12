# Streampixel

Unreal Engine Pixel Streaming as a service — upload your UE builds and stream them directly in the browser via WebRTC.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | NestJS 10, Prisma ORM, PostgreSQL 16, Passport + JWT |
| Frontend | Next.js 14 (App Router), React 18, Tailwind CSS |
| Shared | `@streampixel/shared` — TypeScript types (UserRole, ApiResponse, UserDto) |
| WebSocket | `ws` — signaling server for WebRTC negotiation |
| Containerization | Docker + Docker Compose |
| Language | TypeScript 5.5 |
| Monorepo | npm Workspaces |

## Directory Structure

```
streampixel-monorepo/
├── apps/
│   ├── backend/                    # NestJS API server
│   │   ├── prisma/
│   │   │   ├── schema.prisma       # DB schema (User, RefreshToken, Project, Instance)
│   │   │   └── migrations/        # Auto-generated migrations
│   │   └── src/
│   │       ├── main.ts            # Bootstrap (Swagger, CORS, validation, global prefix /api/v1)
│   │       ├── app.module.ts      # Root module
│   │       ├── auth/              # Register, login, logout, token refresh, JWT strategy
│   │       ├── users/             # User CRUD (bcrypt hashing)
│   │       ├── projects/          # Upload, extract, start/stop instances, signaling server
│   │       ├── prisma/            # Global PrismaModule + PrismaService
│   │       └── common/            # Guards, filters, interceptors, decorators
│   │
│   └── frontend/                   # Next.js web application
│       └── src/
│           ├── middleware.ts       # Route protection (cookie-based)
│           ├── services/api.ts    # Axios client with auto token refresh
│           ├── hooks/useAuth.tsx  # React AuthContext (login, register, logout, refresh)
│           └── app/
│               ├── page.tsx       # Landing page
│               ├── login/         # Login form
│               ├── register/      # Registration form
│               └── dashboard/     # Authenticated area
│                   ├── projects/  # Project list + upload + stream viewer
│                   ├── deployments/  # Placeholder (mock data)
│                   ├── instances/    # Placeholder (mock data)
│                   ├── storage/      # Placeholder (mock data)
│                   ├── settings/     # Static form (no backend)
│                   └── profile/      # User profile (read-only)
│
├── packages/
│   └── shared/                     # @streampixel/shared — shared TypeScript types
│       └── src/index.ts            # UserRole, ApiResponse<T>, UserDto, AuthResponseDto
│
├── infrastructure/
│   └── docker/
│       └── docker-compose.yml      # postgres_db, backend, frontend services
│
├── .env                            # Local dev (localhost:5433 postgres)
├── .env.development                # Docker dev (postgres_db:5432)
├── .env.production                 # Production (streampixel.io)
└── package.json                    # Monorepo root (npm workspaces)
```

## Getting Started

### Prerequisites

- Node.js 18+
- Docker + Docker Compose
- npm

### Development (Docker)

```bash
docker-compose -f infrastructure/docker/docker-compose.yml up --build
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:5000/api/v1
- Swagger docs: http://localhost:5000/api/docs
- PostgreSQL: localhost:5433

### Development (Local)

```bash
# Install dependencies
npm install

# Set up database
npm run db:migrate
npm run db:generate

# Start all services (backend + frontend + shared watcher)
npm run dev
```

### Other Scripts

```bash
npm run build         # Build shared, backend, frontend (in order)
npm run lint          # ESLint across all packages
npm run format        # Prettier formatting
npm run type-check    # TypeScript type checking
npm run db:migrate    # Run Prisma migrations
npm run db:generate   # Generate Prisma client
```

## API Endpoints

All endpoints are prefixed with `/api/v1`.

### Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | No | Register new user |
| POST | `/auth/login` | No | Login, sets HTTPOnly refresh cookie |
| POST | `/auth/logout` | No | Revoke refresh token, clear cookie |
| POST | `/auth/refresh` | Cookie | Rotate tokens (old revoked, new issued) |
| GET | `/auth/me` | Bearer JWT | Get current user profile |

### Projects

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/projects/upload` | Bearer JWT | Upload UE build (ZIP/RAR, max 2GB) |
| GET | `/projects` | Bearer JWT | List user's projects with live client counts |
| GET | `/projects/:id` | Bearer JWT | Get single project |
| DELETE | `/projects/:id` | Bearer JWT | Delete project (stops if running) |
| POST | `/projects/:id/start` | Bearer JWT | Start streaming instance |
| POST | `/projects/:id/stop` | Bearer JWT | Stop streaming instance |

### WebSocket (per project, dynamic port 8800-8900)

| URL | Description |
|-----|-------------|
| `ws://localhost:{port}/` | Streamer (UE app) connects here |
| `ws://localhost:{port}/player` | Browser players connect here |

## Database Schema

4 models via Prisma ORM on PostgreSQL:

```
User (1) ──── (N) RefreshToken   [cascade delete]
User (1) ──── (N) Project        [cascade delete]
Project (1) ── (N) Instance      [cascade delete]
```

- **User**: id, email (unique), name, password (bcrypt), role (ADMIN/USER), timestamps
- **RefreshToken**: id, token (40-byte hex), userId, expiresAt, isRevoked
- **Project**: id, name, version (UE version), status (STOPPED/RUNNING), zipPath, extractedPath, executablePath, userId
- **Instance**: id, projectId, port, status (STARTING/RUNNING/STOPPED/ERROR), pid

## Authentication Flow

1. **Register** → bcrypt hash (10 rounds), return UserDto
2. **Login** → validate credentials, issue JWT access token (15min, in-memory on client) + opaque refresh token (7 days, HTTPOnly cookie, stored in DB)
3. **Auto-refresh** → Axios interceptor catches 401, calls `/auth/refresh`, old token revoked + new pair issued (rotation strategy)
4. **Logout** → revoke refresh token, clear cookie, clear in-memory token
5. **Route protection** → Next.js middleware checks `refresh_token` cookie; backend `JwtAuthGuard` validates Bearer token

## Architecture Highlights

- **Standard response envelope**: All responses wrapped in `{ success, data, error, timestamp }` via global interceptor and exception filter
- **Per-project signaling server**: Each project gets its own WebSocket server on a unique port (8800-8900) for isolated WebRTC streams
- **Simulation mode**: When no UE executable is found in uploaded archives, the frontend renders a canvas-based retro visualization with fake metrics
- **Archive extraction**: Supports both ZIP (adm-zip) and RAR (node-unrar-js) with intelligent `.exe` detection (prefers `Binaries/Win64`, excludes installers/crash reporters)
- **Cross-platform process management**: `taskkill /F /T` on Windows, `kill -SIGKILL` on Unix
- **Optimistic UI updates** on project start/stop operations

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `PORT` | Backend server port | `5000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres:postgres_password@localhost:5433/streampixel` |
| `JWT_ACCESS_SECRET` | JWT signing key | dev key in `.env.example` |
| `JWT_ACCESS_EXPIRATION` | Access token TTL | `15m` |
| `JWT_REFRESH_EXPIRATION` | Refresh token TTL | `7d` |
| `CORS_ORIGIN` | Allowed CORS origins | `http://localhost:3000` |
| `NEXT_PUBLIC_API_URL` | Frontend API base URL | `http://localhost:5000/api/v1` |

## Project Status

- [x] User registration and authentication (JWT + refresh token rotation)
- [x] Project upload (ZIP/RAR) with extraction and exe detection
- [x] Streaming instances with WebSocket signaling
- [x] WebRTC stream viewer in browser
- [x] Simulation mode fallback
- [x] Swagger API documentation
- [x] Docker Compose setup
- [ ] Deployments management (placeholder UI)
- [ ] Instances management (placeholder UI)
- [ ] Storage management (placeholder UI)
- [ ] Settings persistence (static form)
- [ ] Multi-region GPU node orchestration
- [ ] API key management
- [ ] IP whitelisting
- [ ] Role-based access control (ADMIN/USER enum defined, not enforced)
- [ ] Billing/subscription tiers
- [ ] Real-time notifications
