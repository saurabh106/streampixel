# Streampixel

Unreal Engine Pixel Streaming as a SaaS platform -- upload your packaged UE builds and stream them directly in the browser via WebRTC. Built as a TypeScript monorepo with NestJS, Next.js, and Prisma on PostgreSQL.

## Table of Contents

- [Tech Stack](#tech-stack)
- [Architecture Overview](#architecture-overview)
- [Directory Structure](#directory-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Database Schema](#database-schema)
- [Authentication Flow](#authentication-flow)
- [API Reference](#api-reference)
- [Backend Deep Dive](#backend-deep-dive)
- [Frontend Deep Dive](#frontend-deep-dive)
- [Signaling & WebRTC](#signaling--webrtc)
- [Shared Package](#shared-package)
- [Docker & Deployment](#docker--deployment)
- [Code Style & Conventions](#code-style--conventions)
- [Known Issues & Notes](#known-issues--notes)
- [Project Status](#project-status)

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Backend | NestJS | 10.3.x |
| ORM | Prisma | 5.16.x |
| Database | PostgreSQL | 16 |
| Auth | Passport + JWT (access) + opaque refresh tokens | -- |
| Frontend | Next.js (App Router) | 14.2.x |
| UI | React, Tailwind CSS | 18.3.x, 3.4.x |
| Icons | lucide-react | 0.395.x |
| Pixel Streaming | `@epicgames-ps/lib-pixelstreamingfrontend-ue5.5` | 1.3.x |
| Shared Types | `@streampixel/shared` (npm workspace) | -- |
| Signaling | Epic Games Wilbur v2.3.1 (embedded) | -- |
| WebSocket | `ws` | 8.21.x |
| HTTP Client | Axios (with interceptors) | 1.7.x |
| Containerization | Docker + Docker Compose | -- |
| Language | TypeScript | 5.5.x |
| Monorepo | npm Workspaces | -- |
| Code Quality | ESLint + Prettier + Husky + lint-staged | -- |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser (Client)                         │
│  ┌─────────────────┐  ┌──────────────────────────────────────┐  │
│  │   Next.js SPA    │  │   PixelStreaming Library (WebRTC)    │  │
│  │  (Dashboard UI)  │  │   @epicgames-ps/lib-pixelstreaming   │  │
│  └────────┬─────────┘  └──────────────────┬───────────────────┘  │
│           │ REST (JWT)                     │ WebSocket (SDP/ICE)  │
└───────────┼────────────────────────────────┼─────────────────────┘
            │                                │
            ▼                                ▼
┌────────────────────┐       ┌──────────────────────────────┐
│   NestJS Backend    │       │   Wilbur Signaling Server     │
│   (port 5000)       │       │   (port 8800-9100 per inst)   │
│                     │       │   Epic Games PS v2.3.1         │
│  ┌───────────────┐  │       └──────────┬───────────────────┘
│  │ Auth (JWT)     │  │                  │
│  │ Projects CRUD  │  │                  │ WebRTC signaling
│  │ Upload/Extract │  │                  │
│  │ Process Mgmt   │──┼──────────────────┘
│  └───────┬───────┘  │            │
│          │          │            ▼
│          ▼          │   ┌──────────────────────────────┐
│  ┌───────────────┐  │   │   Unreal Engine Process       │
│  │ PostgreSQL     │  │   │   (spawned per instance)      │
│  │ (port 5433)    │  │   │   Pixel Streaming enabled     │
│  └───────────────┘  │   └──────────────────────────────┘
└─────────────────────┘
```

**Key architectural decisions:**
- **Process-per-instance**: Each project instance spawns two child processes (Wilbur signaling + UE executable), tracked in an in-memory `Map`. Zero viewers never triggers auto-shutdown.
- **Dual signaling**: The codebase contains both a legacy custom WebSocket signaling server (`signaling-server.ts`) and the embedded Epic Games Wilbur server. Production uses Wilbur.
- **Simulation mode**: When no UE executable is found, the frontend renders a canvas-based retro visualization with fake metrics.
- **Public sharing**: Each project gets a unique 8-char `shareSlug` for unauthenticated streaming access. Accessing the share link auto-starts the instance if not running.

---

## Directory Structure

```
streampixel-monorepo/
├── apps/
│   ├── agent/                         # Future: local machine agent (empty scaffold)
│   │   └── src/                       # (no source files yet)
│   │
│   ├── backend/                       # NestJS API server
│   │   ├── Dockerfile                 # Multi-stage (dev/build/prod)
│   │   ├── nest-cli.json              # NestJS CLI config
│   │   ├── package.json               # Backend dependencies
│   │   ├── tsconfig.json              # Extends tsconfig.base.json
│   │   ├── prisma/
│   │   │   ├── schema.prisma          # DB schema: User, RefreshToken, Project, Instance
│   │   │   └── migrations/
│   │   │       ├── 20260705042224_init_pixel_streaming/
│   │   │       ├── 20260712090900_add_shareslug/
│   │   │       └── 20260712091600_add_maxccu/
│   │   └── src/
│   │       ├── main.ts                # Bootstrap: Swagger, CORS, validation, global prefix /api/v1
│   │       ├── app.module.ts          # Root module (ConfigModule, Prisma, Users, Auth, Projects)
│   │       ├── prisma/
│   │       │   ├── prisma.module.ts   # @Global() PrismaModule
│   │       │   └── prisma.service.ts  # PrismaClient wrapper (connect/disconnect lifecycle)
│   │       ├── auth/
│   │       │   ├── auth.module.ts     # AuthModule (imports UsersModule, PassportModule, JwtModule)
│   │       │   ├── auth.controller.ts # 5 endpoints: register, login, logout, refresh, me
│   │       │   ├── auth.service.ts    # Auth logic: bcrypt, JWT, refresh token rotation
│   │       │   ├── strategies/
│   │       │   │   └── jwt.strategy.ts    # Passport JWT strategy (Bearer token extraction)
│   │       │   └── dto/
│   │       │       ├── register.dto.ts    # Validation: email (IsEmail), password (min 6), name (optional)
│   │       │       └── login.dto.ts       # Validation: email (IsEmail), password
│   │       ├── users/
│   │       │   ├── users.module.ts    # Provides + exports UsersService
│   │       │   └── users.service.ts   # findByEmail, findById, create (bcrypt 10 rounds)
│   │       ├── projects/
│   │       │   ├── projects.module.ts # Imports PrismaModule, exports ProjectsService
│   │       │   ├── projects.controller.ts       # 6 endpoints (JWT guarded)
│   │       │   ├── projects-public.controller.ts # 1 endpoint (public share link)
│   │       │   ├── projects.service.ts   # Core logic (~1024 lines): upload, extract, start/stop, process mgmt
│   │       │   ├── signaling-server.ts   # Legacy custom WebSocket signaling (254 lines, not used in prod)
│   │       │   └── signaling/            # Embedded Epic Games Wilbur v2.3.1
│   │       │       ├── package.json
│   │       │       ├── tsconfig.json
│   │       │       ├── config.json
│   │       │       ├── Dockerfile         # Standalone signaling Docker build
│   │       │       └── src/
│   │       │           ├── index.ts       # Wilbur entry: Express + SignallingServer
│   │       │           ├── InputHandler.ts
│   │       │           ├── Utils.ts
│   │       │           └── paths/         # REST API route handlers
│   │       │               ├── config.ts  # GET /api/config
│   │       │               ├── players.ts # GET /api/players
│   │       │               ├── status.ts  # GET /api/status
│   │       │               ├── streamers.ts
│   │       │               └── players/{playerId}.ts
│   │       └── common/
│   │           ├── guards/
│   │           │   └── jwt-auth.guard.ts      # Passport JWT guard
│   │           ├── filters/
│   │           │   └── http-exception.filter.ts # Global exception -> ApiResponse error format
│   │           ├── interceptors/
│   │           │   └── transform.interceptor.ts # Wraps responses in { success, data, timestamp }
│   │           └── decorators/
│   │               └── get-user.decorator.ts    # @GetUser() parameter decorator
│   │
│   └── frontend/                      # Next.js 14 web application
│       ├── Dockerfile                 # Multi-stage (dev/build/prod)
│       ├── package.json               # Frontend dependencies
│       ├── next.config.js             # reactStrictMode: true
│       ├── tsconfig.json              # Path aliases: @/* -> ./src/*, @streampixel/shared -> source
│       ├── tailwind.config.ts         # Custom dark theme, glassmorphism tokens, accent colors
│       ├── postcss.config.js          # Tailwind + Autoprefixer
│       └── src/
│           ├── middleware.ts           # Route guard: /dashboard requires refresh_token cookie
│           ├── services/
│           │   └── api.ts             # Axios client: auto token refresh with queue pattern
│           ├── hooks/
│           │   └── useAuth.tsx        # React Context: login, register, logout, refreshUser
│           ├── components/
│           │   └── PixelStreamPlayer.tsx  # WebRTC stream viewer + canvas simulation fallback
│           └── app/
│               ├── layout.tsx          # Root layout: Inter font, AuthProvider wrapper
│               ├── page.tsx            # Marketing landing page (Server Component)
│               ├── globals.css         # Tailwind directives, glass-card, glow-btn, scrollbar styles
│               ├── login/page.tsx      # Login form
│               ├── register/page.tsx   # Registration form
│               ├── watch/
│               │   └── [shareSlug]/
│               │       └── page.tsx    # Public stream viewer (no auth, auto-starts instance)
│               └── dashboard/
│                   ├── layout.tsx      # Sidebar + top header + user dropdown
│                   ├── page.tsx        # Redirects to /dashboard/projects
│                   ├── projects/
│                   │   ├── page.tsx         # Project list, upload modal, start/stop/delete
│                   │   └── [id]/stream/
│                   │       └── page.tsx     # Stream viewer + diagnostics panel
│                   ├── instances/page.tsx   # Live CCU analytics (polls every 3s)
│                   ├── deployments/page.tsx # Placeholder (mock data)
│                   ├── storage/page.tsx     # Placeholder (mock data)
│                   ├── settings/page.tsx    # Static form (no backend persistence)
│                   └── profile/page.tsx     # User profile (read-only)
│
├── packages/
│   └── shared/                        # @streampixel/shared
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── index.ts              # UserRole, ApiResponse<T>, UserDto, AuthResponseDto
│
├── infrastructure/
│   └── docker/
│       └── docker-compose.yml         # postgres_db, backend, frontend services
│
├── .env                               # Local dev (localhost:5433 postgres)
├── .env.development                   # Docker dev (postgres_db:5432)
├── .env.production                    # Production (streampixel.io)
├── .env.example                       # Template with documented variables
├── .eslintrc.json                     # ESLint: TS + Prettier
├── .prettierrc                        # Single quotes, trailing commas, 100 width
├── .lintstagedrc                      # Pre-commit: eslint --fix + prettier
├── .gitignore
├── tsconfig.base.json                 # Shared TS config (apps extend this)
├── tsconfig.json                      # Root TS config (IDE path alias resolution)
└── package.json                       # Monorepo root (npm workspaces, dev scripts)
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Docker + Docker Compose (for database and containerized dev)
- npm 9+
- PostgreSQL 16 (if running locally without Docker)
- Windows: `taskkill` available (for process management); Linux: standard `kill`/`/proc`

### Development (Docker -- recommended)

```bash
# Clone and install
git clone <repo-url> && cd streampixel-monorepo
npm install

# Start all services (DB + backend + frontend)
docker-compose -f infrastructure/docker/docker-compose.yml up --build
```

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:5000/api/v1 |
| Swagger docs | http://localhost:5000/api/docs |
| PostgreSQL | localhost:5433 (mapped from container 5432) |

### Development (Local)

```bash
# Install dependencies
npm install

# Set up database
npm run db:migrate    # Run Prisma migrations
npm run db:generate   # Generate Prisma client

# Start all services (backend + frontend + shared watcher)
npm run dev
```

### Useful Scripts

```bash
npm run build         # Build shared -> backend -> frontend (sequential)
npm run lint          # ESLint across all packages
npm run format        # Prettier formatting
npm run type-check    # TypeScript type checking across all packages
npm run db:migrate    # Run Prisma migrations (delegates to backend workspace)
npm run db:generate   # Generate Prisma client (delegates to backend workspace)
```

---

## Environment Variables

| Variable | Description | Local Default | Docker Dev | Production |
|----------|-------------|---------------|------------|------------|
| `NODE_ENV` | Environment mode | `development` | `development` | `production` |
| `PORT` | Backend server port | `5000` | `5000` | `5000` |
| `CORS_ORIGIN` | Allowed CORS origins (comma-separated) | `http://localhost:3000` | `http://localhost:3000` | `https://app.streampixel.io` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres:postgres_password@localhost:5433/streampixel?schema=public` | `postgresql://postgres:postgres_password@postgres_db:5432/streampixel?schema=public` | `postgresql://postgres:<password>@<host>:5432/streampixel?schema=public` |
| `JWT_ACCESS_SECRET` | JWT access token signing key | `dev_jwt_access_token_secret_1234567890_streampixel` | same | **Replace with secure secret** |
| `JWT_REFRESH_SECRET` | Reserved (refresh tokens are opaque, not JWT) | `dev_jwt_refresh_token_secret_0987654321_streampixel` | same | **Replace with secure secret** |
| `JWT_ACCESS_EXPIRATION` | Access token TTL | `15m` | `15m` | `15m` |
| `JWT_REFRESH_EXPIRATION` | Refresh token TTL | `7d` | `7d` | `7d` |
| `NEXT_PUBLIC_API_URL` | Frontend API base URL (public, baked into client bundle) | `http://localhost:5000/api/v1` | `http://localhost:5000/api/v1` | `https://api.streampixel.io/api/v1` |
| `STORAGE_PATH` | Root directory for uploaded UE builds | `/opt/streampixel/store` | `/opt/streampixel/store` | `/opt/streampixel/store` |
| `AGENT_SECRET` | Shared secret for local agent auth (future) | `change-me-to-a-secure-random-string` | -- | -- |
| `SIGNALING_URL` | Public signaling server URL (future) | `ws://127.0.0.1` | -- | -- |

---

## Database Schema

PostgreSQL via Prisma ORM. 4 models, 1 enum, 3 migrations.

```
User (1) ────── (N) RefreshToken    [cascade delete]
User (1) ────── (N) Project         [cascade delete]
Project (1) ──── (N) Instance       [cascade delete]
```

### Enums

| Enum | Values |
|------|--------|
| `Role` | `ADMIN`, `USER` |

### Models

#### User (`users` table)

| Field | Type | Attributes |
|-------|------|------------|
| `id` | String (UUID) | `@id @default(uuid())` |
| `email` | String | `@unique` |
| `name` | String? | nullable |
| `password` | String | bcrypt hashed (10 rounds) |
| `role` | Role | `@default(USER)` |
| `createdAt` | DateTime | `@default(now())` |
| `updatedAt` | DateTime | `@updatedAt` |

#### RefreshToken (`refresh_tokens` table)

| Field | Type | Attributes |
|-------|------|------------|
| `id` | String (UUID) | `@id @default(uuid())` |
| `token` | String | `@unique` (40-byte random hex) |
| `userId` | String | FK -> User (cascade) |
| `expiresAt` | DateTime | |
| `isRevoked` | Boolean | `@default(false)` |
| `createdAt` | DateTime | `@default(now())` |

#### Project (`projects` table)

| Field | Type | Attributes |
|-------|------|------------|
| `id` | String (UUID) | `@id @default(uuid())` |
| `name` | String | display name |
| `version` | String | UE version label (e.g., "5.4") |
| `status` | String | `@default("STOPPED")` -- `"RUNNING"` or `"STOPPED"` |
| `zipPath` | String? | path to uploaded archive on disk |
| `extractedPath` | String? | path to extraction directory |
| `executablePath` | String? | relative path to discovered UE binary |
| `shareSlug` | String? | `@unique` -- random 8-char slug for public sharing |
| `maxCCU` | Int | `@default(3)` -- max concurrent viewers |
| `userId` | String | FK -> User (cascade) |

#### Instance (`instances` table)

| Field | Type | Attributes |
|-------|------|------------|
| `id` | String (UUID) | `@id @default(uuid())` |
| `projectId` | String | FK -> Project (cascade) |
| `port` | Int | player WebSocket port allocated |
| `status` | String | `@default("STARTING")` -- `"STARTING"`, `"RUNNING"`, `"STOPPED"`, `"ERROR"` |
| `pid` | Int? | OS process ID of UE executable (`9999` = simulated) |

### Migrations

| Migration | Date | Changes |
|-----------|------|---------|
| `20260705042224_init_pixel_streaming` | 2026-07-05 | Initial: all 4 tables + Role enum + indexes + foreign keys |
| `20260712090900_add_shareslug` | 2026-07-12 | Added `shareSlug` column (unique) to projects |
| `20260712091600_add_maxccu` | 2026-07-12 | Added `maxCCU` column (default 3) to projects |

---

## Authentication Flow

### Token Strategy

- **Access Token**: JWT (signed with `JWT_ACCESS_SECRET`), stored in-memory on the client (JavaScript module variable). Contains `{ sub: userId, email, role }`. Expires in 15 minutes.
- **Refresh Token**: Opaque random hex string (40 bytes), stored in PostgreSQL `refresh_tokens` table and set as an HTTPOnly secure cookie (`refresh_token`). Expires in 7 days.
- **Rotation**: On every refresh, the old token is revoked and a new pair is issued.

### Flow Diagram

```
Register:    POST /auth/register  -->  bcrypt hash  -->  Return UserDto
                                                            |
Login:       POST /auth/login     -->  validate creds      |
             Set HTTPOnly cookie (refresh_token)            |
             Return { user, accessToken } (in-memory)      |
                                                            |
Use API:     GET /api/*  +  Authorization: Bearer <token>   |
             Backend validates JWT, attaches user to request |
                                                            |
Token Expired:  401 response                                |
             Axios interceptor catches 401                  |
             POST /auth/refresh  (cookie sent automatically)|
             Backend: revoke old token, issue new pair       |
             Retry original request with new token           |
             (Queue pattern: concurrent 401s share one refresh)
                                                            |
Logout:      POST /auth/logout  -->  revoke token in DB     |
             Clear cookie  -->  Clear in-memory token        |
```

### Route Protection

- **Next.js Middleware** (`src/middleware.ts`): Checks for `refresh_token` cookie presence on `/dashboard/*`, `/login`, `/register` routes. Lightweight guard (does not validate server-side).
- **Backend Guard**: `JwtAuthGuard` validates the Bearer JWT on protected endpoints. Returns `UnauthorizedException` if missing/invalid.
- **Public routes**: `/watch/[shareSlug]` and `/api/v1/public/projects/share/:shareSlug` require no authentication.

---

## API Reference

All backend endpoints are prefixed with `/api/v1`. All responses are wrapped in the standard envelope:

```json
{
  "success": true,
  "data": { ... },
  "timestamp": "2026-07-18T12:00:00.000Z"
}
```

Error responses:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": [ ... ]
  },
  "timestamp": "2026-07-18T12:00:00.000Z"
}
```

### Authentication

| Method | Path | Auth | Body | Response | Description |
|--------|------|------|------|----------|-------------|
| `POST` | `/auth/register` | No | `{ email, password, name? }` | `UserDto` | Register new user (bcrypt 10 rounds) |
| `POST` | `/auth/login` | No | `{ email, password }` | `{ user, accessToken }` + cookie | Login, sets HTTPOnly refresh cookie |
| `POST` | `/auth/logout` | Cookie | `{ refreshToken }` or cookie | `{ message }` | Revoke refresh token, clear cookie |
| `POST` | `/auth/refresh` | Cookie | `{ refreshToken }` or cookie | `{ user, accessToken }` + cookie | Rotate tokens (old revoked, new issued) |
| `GET` | `/auth/me` | Bearer JWT | -- | `UserDto` | Get current user profile |

### Projects (Authenticated)

| Method | Path | Auth | Body | Response | Description |
|--------|------|------|------|----------|-------------|
| `POST` | `/projects/upload` | Bearer JWT | `multipart/form-data`: `file` (ZIP/RAR, max 2GB), `name`, `version` | `Project` | Upload UE build, extract, detect executable |
| `GET` | `/projects` | Bearer JWT | -- | `Project[]` | List user's projects with live client counts |
| `GET` | `/projects/:id` | Bearer JWT | -- | `Project` | Get single project with instances |
| `DELETE` | `/projects/:id` | Bearer JWT | -- | `{ success: true }` | Delete project (stops instance, cleans files) |
| `POST` | `/projects/:id/start` | Bearer JWT | -- | `{ message, port, status, isSimulated }` | Start streaming instance |
| `POST` | `/projects/:id/stop` | Bearer JWT | -- | `{ message, status }` | Stop running instance |

### Public (No Auth)

| Method | Path | Params | Response | Description |
|--------|------|--------|----------|-------------|
| `GET` | `/public/projects/share/:shareSlug` | `shareSlug` | `{ id, name, version, status, port, isSimulated }` | Get or auto-start a shared project |

### Swagger Documentation

Interactive API docs available at: `http://localhost:5000/api/docs` (configured via `@nestjs/swagger` with Bearer Auth support).

### Wilbur Signaling REST API (per instance)

Each running instance exposes Wilbur's REST API on its allocated port:

| Method | Path | Response |
|--------|------|----------|
| `GET` | `http://127.0.0.1:{port}/api/status` | `{ uptime, streamer_count, player_count, version }` |
| `GET` | `http://127.0.0.1:{port}/api/config` | Server and protocol configuration |
| `GET` | `http://127.0.0.1:{port}/api/players` | Connected player info |
| `GET` | `http://127.0.0.1:{port}/api/streamers` | Connected streamer info |

---

## Backend Deep Dive

### Bootstrap (`src/main.ts`)

1. Creates NestJS app from `AppModule`
2. Sets global prefix: **`api/v1`**
3. Registers `cookie-parser` middleware
4. Registers global `ValidationPipe` (whitelist, transform, forbidNonWhitelisted)
5. Registers global `HttpExceptionFilter` and `TransformInterceptor`
6. Enables CORS with configurable origins + credentials
7. Configures Swagger at `/api/docs` with Bearer Auth
8. Listens on `PORT` (default `5000`)

### Modules

| Module | Controllers | Services | Description |
|--------|------------|----------|-------------|
| `AppModule` | -- | -- | Root module, imports ConfigModule (global), Prisma, Users, Auth, Projects |
| `PrismaModule` | -- | `PrismaService` | `@Global()` module, wraps PrismaClient with lifecycle hooks |
| `AuthModule` | `AuthController` | `AuthService` | Authentication: register, login, logout, refresh, me |
| `UsersModule` | -- | `UsersService` | User CRUD: findByEmail, findById, create |
| `ProjectsModule` | `ProjectsController`, `ProjectsPublicController` | `ProjectsService` | Upload, extract, start/stop instances, process management |

### Common Utilities

| Type | Name | Location | Description |
|------|------|----------|-------------|
| Guard | `JwtAuthGuard` | `common/guards/jwt-auth.guard.ts` | Passport JWT guard, throws `UnauthorizedException` |
| Filter | `HttpExceptionFilter` | `common/filters/http-exception.filter.ts` | Maps all exceptions to `ApiResponse` error format |
| Interceptor | `TransformInterceptor` | `common/interceptors/transform.interceptor.ts` | Wraps successful responses in `{ success, data, timestamp }` |
| Decorator | `@GetUser()` | `common/decorators/get-user.decorator.ts` | Extracts `request.user` or specific property |

### Projects Service -- Core Logic (`projects.service.ts`, ~1024 lines)

This is the heart of the application. Key behaviors:

#### Upload & Extraction

1. Validates file is provided (ZIP or RAR, max 2GB)
2. Writes uploaded buffer to `storage/projects/{projectId}/`
3. Detects format by extension: ZIP (`adm-zip`) or RAR (`node-unrar-js`)
4. Extracts archive contents
5. **Executable discovery** (two-pass scan):
   - **Pass 1**: Scans root directory only (non-recursive)
   - **Pass 2**: Recurses subdirectories, **skipping `Engine/` entirely**
   - Linux: checks `X_OK` permission bit, rejects `.so`, `.sh`, `.py`, `.pak`
   - Windows: matches `.exe` extension
   - Excludes: `crashreport`, `uninstall`, `prereq`, `install`, `setup`, `launcher`, `messagelogger`, `fileopenorder`, `dotnet`, `redist`, `shaders`, `tools`, `epicgames`
6. If no executable found: sets `isSimulated = true` (frontend uses canvas fallback)

#### Instance Start (`startInstance`)

1. Validates project ownership and checks for existing running instance
2. **Port allocation**: Finds free ports in range 8800-9100 via TCP bind test (3 ports per instance: streamer, player, SFU)
3. **Spawns Wilbur signaling server** as child process:
   ```
   node <signalingDir>/dist/index.js \
     --no_config --streamer_port X --player_port Y --sfu_port Z \
     --max_players N --console_messages verbose --rest_api --serve --cors
   ```
4. **Waits for readiness**: TCP port probe (5s timeout) + HTTP `/status` check (3s timeout)
5. **Spawns UE process** with flags:
   - Common: `-AudioMixer`, `-PixelStreamingSignallingURL=ws://...`, `-PixelStreamingEncoderCodec=H264`, `-WebRTCFps=60`, `-ResX=1920`, `-ResY=1080`
   - Linux: `-RenderOffscreen`, `-vulkan`, `-nosound`
   - Windows: `-RenderOffscreen`, `-Windowed`
6. Registers both processes in in-memory `activeProcesses` Map
7. Creates `Instance` DB record, updates `Project.status` to `RUNNING`

#### Instance Stop (`stopInstance`)

1. Kills both UE and signaling process trees
   - Windows: `taskkill /F /T /PID {pid}` (recursive)
   - Linux: Walks `/proc/{pid}/task/{pid}/children`, kills bottom-up with `SIGKILL`
2. Removes from `activeProcesses` map
3. Updates all RUNNING instances to STOPPED in DB
4. Updates project status to STOPPED

#### Startup Recovery (`onModuleInit`)

On backend restart, probes all DB instances marked `RUNNING`:
- TCP socket probe on signaling port
- If alive: preserves running state
- If dead: marks Instance + Project as STOPPED

#### Metrics Polling

- 3-second `setInterval` polls each active instance's `/status` endpoint
- Updates `clients` count (player count) for dashboard display
- Informational only -- never triggers auto-stop

### Legacy Signaling Server (`signaling-server.ts`)

A standalone WebSocket server using the `ws` library directly. **Not used in production** (replaced by Wilbur). Retained for reference:
- Role detection by URL path (`/player` -> player, else -> streamer)
- Random `playerId` assignment (100-1099)
- ICE server config: `stun:stun.l.google.com:19302`
- Message forwarding between streamer and players
- Binary message relay

---

## Frontend Deep Dive

### Pages & Routes

| Route | Component | Auth | Type | Description |
|-------|-----------|------|------|-------------|
| `/` | `page.tsx` | No | Server | Marketing landing page with feature grid |
| `/login` | `login/page.tsx` | No | Client | Email/password login form |
| `/register` | `register/page.tsx` | No | Client | Registration form (redirects to login on success) |
| `/dashboard` | `dashboard/page.tsx` | Yes | Server | Redirects to `/dashboard/projects` |
| `/dashboard/projects` | `projects/page.tsx` | Yes | Client | Project list, upload modal, start/stop/delete |
| `/dashboard/projects/:id/stream` | `projects/[id]/stream/page.tsx` | Yes | Client | Stream viewer + diagnostics panel |
| `/dashboard/instances` | `instances/page.tsx` | Yes | Client | Live CCU analytics (polls every 3s) |
| `/dashboard/deployments` | `deployments/page.tsx` | Yes | Client | Placeholder (mock data) |
| `/dashboard/storage` | `storage/page.tsx` | Yes | Client | Placeholder (mock data) |
| `/dashboard/settings` | `settings/page.tsx` | Yes | Client | Static form (no backend persistence) |
| `/dashboard/profile` | `profile/page.tsx` | Yes | Client | User profile (read-only) |
| `/watch/:shareSlug` | `watch/[shareSlug]/page.tsx` | No | Client | Public stream viewer (auto-starts instance) |

### Dashboard Layout (`dashboard/layout.tsx`)

- **Sidebar** (264px, fixed): Navigation with 6 items (Projects, Deployments, Instances, Storage, Settings, Profile). Mobile: slide-in overlay with hamburger toggle.
- **Top Header** (sticky, 64px): Current page title, notification bell (decorative), user dropdown (avatar, email, profile link, sign out).
- **Main Content**: `max-w-7xl mx-auto` with padding.

### API Service (`services/api.ts`)

**Axios instance** with interceptors:

- **Request interceptor**: Attaches `Authorization: Bearer <token>` header from in-memory cache.
- **Response interceptor (success)**: Unwraps `ApiResponse` envelope (returns `response.data.data`).
- **Response interceptor (error)**: On 401, triggers token refresh with a **queue pattern**:
  1. If refresh already in progress, subsequent failed requests are queued as Promises.
  2. After refresh succeeds, all queued requests retry with the new token.
  3. On refresh failure: clears tokens, redirects to `/login`.

**Token storage**: `cachedAccessToken` is a module-level variable. Never persisted to localStorage or cookies. Re-hydrated from `/auth/refresh` on page load.

### Auth Hook (`hooks/useAuth.tsx`)

React Context providing:
- `user: UserDto | null` -- current user
- `loading: boolean` -- initial auth check in progress
- `login(email, password)` -- POST `/auth/login`, cache token, navigate to dashboard
- `register(email, password, name?)` -- POST `/auth/register` (does not auto-login)
- `logout()` -- POST `/auth/logout`, clear everything, navigate to login
- `refreshUser()` -- GET `/auth/me` to refresh user object
- `isAuthenticated: boolean` -- computed `!!user`

### PixelStreamPlayer Component (`components/PixelStreamPlayer.tsx`)

The most complex frontend component (~475 lines). Props:

```typescript
{
  port: number;              // WebSocket signaling server port
  isSimulated?: boolean;     // Use canvas simulation instead of real WebRTC
  fullscreen?: boolean;      // Full viewport mode vs aspect-video
  onLog?: (msg: string) => void;  // Callback for connection logs
}
```

**Real streaming mode** (`isSimulated === false`):
1. Patches `window.WebSocket` globally to queue messages sent before `open` event (prevents "WebSocket is not open" errors)
2. Dynamically imports `@epicgames-ps/lib-pixelstreamingfrontend-ue5.5` (cached at module scope)
3. Creates `PixelStreaming` instance with config: auto-connect, auto-play, muted start, H264, 60fps, 50Mbps max bitrate
4. Handles events: `webRtcConnecting`, `webRtcConnected`, `videoInitialized`, `webRtcDisconnected`, `webRtcFailed` (with 3x retry)
5. 30-second connection timeout

**Simulation mode** (`isSimulated === true`):
1. Creates a 1280x720 canvas with animated scene:
   - Dark background with perspective grid floor
   - Flying particles in blue/cyan hues (3D projection)
   - Rotating 3D wireframe octahedron (cyan `#22d3ee`)
   - HUD overlay: simulated FPS (~60), RTT (~15ms), BITRATE (4.8 Mbps)
   - Blinking red "LIVE" indicator
2. Captures canvas as 30fps MediaStream, feeds to a `<video>` element

**Library preloading**: `preloadPixelStreamingLibrary()` starts the dynamic import early. Called by the public watch page to parallelize loading while the API request is in flight.

### Design System

**Theme** (Tailwind):
- Background: `#070913` (near-black), Foreground: `#F1F5F9` (light slate)
- Primary: `#6366F1` (indigo-500)
- Accents: Cyan `#06B6D4`, Violet `#8B5CF6`, Pink `#EC4899`
- Sidebar: `#0C0E1C` (dark navy)

**Custom CSS classes** (`globals.css`):
- `.glass-card` -- glassmorphism: 45% slate bg, 16px blur, 6% white border
- `.glass-panel` -- 60% opacity, 20px blur, 4% white border (sidebar/header)
- `.glow-btn` -- animated shimmer sweep on hover
- `.ps-fullscreen video` -- forces video to fill viewport

**UI Patterns** (inline, not componentized):
- Status badges: color-coded pills (emerald=active, slate=inactive, red=danger)
- Tables: `divide-y divide-slate-900/60` with hover states
- Modals: fixed overlay with `bg-black/70` + glass-card content + zoom animation
- Error banners: `bg-red-500/10` with AlertCircle icon
- Loading states: spinning `RefreshCw`/`Loader2` icons

---

## Signaling & WebRTC

### Wilbur Signaling Server (Production)

Embedded copy of Epic Games' Wilbur v2.3.1 (`apps/backend/src/projects/signaling/`). Runs as a separate Node.js child process per project instance.

**Architecture**:
- **Streamer port** (WebSocket): UE process connects here
- **Player port** (WebSocket + HTTP): Browser players connect here; also serves web server and REST API
- **SFU port**: Selective Forwarding Unit connections (for SFU topology)

**CLI arguments used**:
```
--no_config                           # Ignore config.json
--streamer_port <port>                # Dynamic port
--player_port <port>                  # Dynamic port
--sfu_port <port>                     # Dynamic port
--max_players <N>                     # From project's maxCCU (default 3)
--console_messages verbose            # Detailed logging
--rest_api                            # Enable /api/* endpoints
--serve                               # Enable web server on player port
--cors                                # Enable CORS headers
```

### Port Allocation

Three ports per instance, dynamically allocated from range **8800-9100**:
1. `streamerPort` -- UE process WebSocket connection
2. `playerPort` -- Browser player WebSocket + HTTP server
3. `sfuPort` -- SFU connections

Port availability is tested via TCP bind (`net.createServer().listen(port)`).

### Connection Flow

```
1. User clicks "Start Stream" or accesses /watch/:shareSlug
2. Backend allocates ports, spawns Wilbur + UE process
3. UE connects to Wilbur on streamerPort (WebSocket)
4. Browser connects to Wilbur on playerPort (WebSocket)
5. Wilbur brokers SDP offer/answer between UE and browser
6. ICE candidates exchanged via Wilbur
7. Direct WebRTC P2P stream established (H264, 60fps, 1080p)
8. Browser renders video in <video> element
```

---

## Shared Package

**Package**: `@streampixel/shared` (`packages/shared/`)

A minimal type contract between frontend and backend. Single source file, zero runtime dependencies.

### Exports

| Export | Kind | Description |
|--------|------|-------------|
| `UserRole` | `enum` | `ADMIN = 'ADMIN'`, `USER = 'USER'` |
| `ApiResponse<T>` | `interface` | Generic response envelope: `{ success, data?, error?, timestamp }` |
| `UserDto` | `interface` | User data: `id, email, name, role, createdAt, updatedAt` |
| `AuthResponseDto` | `interface` | Auth response: `{ user: UserDto, accessToken: string }` |

**Development import**: The frontend imports TypeScript source directly via tsconfig path alias (`@streampixel/shared` -> `packages/shared/src/index.ts`), no build step needed during dev.

---

## Docker & Deployment

### Docker Compose Services

| Service | Container | Ports | Depends On | Volume Mounts |
|---------|-----------|-------|------------|---------------|
| `postgres_db` | `streampixel_postgres` | 5433:5432 | -- | `postgres_data:/var/lib/postgresql/data` |
| `backend` | `streampixel_backend` | 5000:5000 | postgres_db (healthy) | `../../:/app` + anonymous `node_modules` |
| `frontend` | `streampixel_frontend` | 3000:3000 | backend | `../../:/app` + anonymous `node_modules` + `.next` |

### Dockerfiles

Both `backend` and `frontend` use **multi-stage builds** with 3 stages:

| Stage | Base | Purpose |
|-------|------|---------|
| `development` | `node:20-alpine` | Hot-reload dev mode with live mounts |
| `builder` | `node:20-alpine` | Full production build (shared -> app) |
| `production` | `node:20-alpine` | Slim runtime with only built artifacts |

### Port Map

| Port | Service | Purpose |
|------|---------|---------|
| 3000 | Frontend | Next.js web app |
| 5000 | Backend | NestJS API server |
| 5433 | PostgreSQL | Database (host-mapped from container 5432) |
| 8800-9100 | Signaling (per instance) | Wilbur servers (streamer/player/SFU ports) |

---

## Code Style & Conventions

### TypeScript

- Target: ES2022, Module: CommonJS
- Selective strict: `strictNullChecks`, `noImplicitAny`, `strictBindCallApply` (not full `strict: true`)
- Decorator metadata enabled (NestJS requirement)

### ESLint

- Parser: `@typescript-eslint/parser`
- Extends: `eslint:recommended` + `@typescript-eslint/recommended` + `prettier`
- Relaxed rules: `no-explicit-any: off`, `explicit-function-return-type: off`
- Prettier violations are ESLint errors

### Prettier

- Single quotes, trailing commas (all), 100 char width, 2-space indent, semicolons, LF line endings

### Backend Conventions

- **Global prefix**: All routes under `/api/v1`
- **Response envelope**: All responses wrapped by `TransformInterceptor` in `{ success, data, timestamp }`
- **Exception format**: All errors wrapped by `HttpExceptionFilter` in `{ success: false, error: { code, message, details }, timestamp }`
- **Validation**: `class-validator` decorators on DTOs, global `ValidationPipe` with whitelist+transform+forbidNonWhitelisted
- **Prisma**: Global module, service extends `PrismaClient` with lifecycle hooks
- **Module pattern**: Feature modules with controller + service, PrismaModule imported per-module

### Frontend Conventions

- **App Router**: Next.js 14 with `app/` directory
- **Client vs Server**: Pages requiring state/interactivity use `'use client'`; landing page and root layout are Server Components
- **State management**: Local `useState` + `useEffect` (no Redux/Zustand). Auth via React Context only.
- **Styling**: Tailwind CSS with custom theme tokens. No component library (all UI is inline).
- **Path aliases**: `@/*` -> `./src/*`, `@streampixel/shared` -> shared package source

### Git Hooks

- **Husky** + **lint-staged** configured but not yet initialized (`.husky/` directory missing)
- Intended: pre-commit runs `eslint --fix` + `prettier --write` on staged files
- Run `npx husky init` to activate

---

## Known Issues & Notes

1. **Agent app is empty**: `apps/agent/src/` contains no files. The `AGENT_SECRET` and `SIGNALING_URL` env vars in `.env` are reserved for a future local machine agent that would connect UE builds to the signaling server.

2. **Husky not initialized**: The `prepare` script and `.lintstagedrc` are configured, but `.husky/` doesn't exist. Run `npx husky init` to enable git hooks.

3. **`.env` committed to git**: Despite being in `.gitignore`, the `.env` file exists in the repo (dev convenience). Should be removed before production.

4. **Production env has placeholder secrets**: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `DATABASE_URL` in `.env.production` contain placeholder values that must be replaced.

5. **Mock data pages**: Deployments, Storage, and Settings pages use hardcoded mock data with no backend integration. These are placeholder UIs for Phase 2/3.

6. **No public/ directory**: `apps/frontend/public/` doesn't exist yet. Referenced in Dockerfile for production but not created.

7. **Legacy signaling server**: `projects/signaling-server.ts` is a complete but unused custom WebSocket signaling implementation (254 lines). Production uses the embedded Wilbur server instead.

8. **Role-based access control**: The `UserRole` enum (`ADMIN`/`USER`) is defined in the shared package and stored in the DB, but not enforced in any backend guard or middleware.

9. **No shared UI components**: All UI elements (buttons, cards, tables, modals, badges) are inline within page files. No component library or design system abstraction layer exists.

10. **Dual tsconfig strict mode**: Root `tsconfig.json` uses `strict: true` (full), but `tsconfig.base.json` (which apps extend) uses selective strict flags. Apps get softer strictness.

---

## Project Status

- [x] User registration and authentication (JWT + refresh token rotation)
- [x] Project upload (ZIP/RAR) with extraction and executable detection
- [x] Streaming instances with Wilbur signaling server
- [x] WebRTC stream viewer in browser (Epic Pixel Streaming library)
- [x] Canvas-based simulation mode fallback (animated 3D scene)
- [x] Public share links (auto-start on access)
- [x] Swagger API documentation
- [x] Docker Compose setup (3 services)
- [x] Cross-platform process management (Windows + Linux)
- [x] Startup recovery (stale instance cleanup on restart)
- [x] Live CCU metrics polling
- [ ] Deployments management (placeholder UI only)
- [ ] Instances management (placeholder UI only)
- [ ] Storage management (placeholder UI only)
- [ ] Settings persistence (static form, no backend)
- [ ] Agent app implementation (empty scaffold)
- [ ] Multi-region GPU node orchestration
- [ ] API key management
- [ ] IP whitelisting
- [ ] Role-based access control (enum defined, not enforced)
- [ ] Billing/subscription tiers
- [ ] Real-time notifications
- [ ] Husky git hooks activation
- [ ] Shared UI component library
