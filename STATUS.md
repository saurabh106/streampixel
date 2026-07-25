# StreamPixel — Current Status & Problem Statement

## What Is This Project?

StreamPixel is a SaaS platform for Unreal Engine Pixel Streaming. Users upload packaged UE builds (ZIP/RAR), and the platform streams them in-browser via WebRTC. Think of it as "GeForce NOW but self-hosted for your own UE projects."

## Architecture

```
EC2 Instance (Ubuntu 24.04, IP: 13.201.4.220, NO GPU)
├── Docker Compose (production)
│   ├── streampixel_frontend  (Next.js 14, port 3000)
│   ├── streampixel_backend   (NestJS, port 5000)
│   └── streampixel_postgres  (PostgreSQL 16, port 5434)
```

### Monorepo Structure
```
streampixel/
├── apps/
│   ├── agent/                          # Future: local machine agent (empty scaffold)
│   ├── backend/                        # NestJS API server
│   │   ├── Dockerfile                  # Multi-stage: dev/builder/production
│   │   ├── prisma/
│   │   │   ├── schema.prisma           # 4 models: User, RefreshToken, Project, Instance
│   │   │   └── migrations/             # 3 migrations (init, shareslug, maxccu)
│   │   └── src/
│   │       ├── main.ts                 # Bootstrap: Swagger, CORS, validation, prefix /api/v1
│   │       ├── app.module.ts           # Root module
│   │       ├── app.controller.ts       # Root `/` endpoint
│   │       ├── health.controller.ts    # `/health` endpoint
│   │       ├── auth/                   # JWT auth (register, login, refresh, logout, me)
│   │       │   ├── strategies/         # Passport JWT strategy
│   │       │   └── dto/                # RegisterDto, LoginDto (class-validator)
│   │       ├── users/                  # User CRUD (findByEmail, findById, create)
│   │       ├── projects/               # CORE: upload, extract, spawn UE + Wilbur signaling
│   │       │   ├── signaling-server.ts # Legacy custom WebSocket signaling (unused in prod)
│   │       │   └── signaling/          # Embedded Epic Games Wilbur v2.3.1
│   │       ├── prisma/                 # @Global() PrismaModule + PrismaService
│   │       └── common/
│   │           ├── guards/             # JwtAuthGuard
│   │           ├── filters/            # HttpExceptionFilter (error envelope)
│   │           ├── interceptors/       # TransformInterceptor (success envelope)
│   │           ├── decorators/         # @GetUser() parameter decorator
│   │           └── types/              # shared.types.ts (local copy of shared types)
│   └── frontend/                       # Next.js 14 (App Router)
│       ├── Dockerfile                  # Multi-stage: dev/builder/production
│       └── src/
│           ├── middleware.ts           # Route guard: /dashboard requires refresh_token cookie
│           ├── services/api.ts         # Axios client: auto token refresh with queue pattern
│           ├── hooks/useAuth.tsx        # React Context: login, register, logout, refreshUser
│           ├── components/             # PixelStreamPlayer.tsx (WebRTC viewer + simulation)
│           └── app/
│               ├── page.tsx            # Marketing landing page (Server Component)
│               ├── login/              # Login form
│               ├── register/           # Registration form
│               ├── watch/[shareSlug]/  # Public stream viewer (no auth, auto-starts)
│               └── dashboard/          # Authenticated UI
│                   ├── layout.tsx      # Sidebar + top header + user dropdown
│                   ├── projects/       # Project list, upload modal, stream viewer
│                   ├── instances/      # Live CCU analytics (polls every 3s)
│                   ├── deployments/    # Placeholder (mock data)
│                   ├── storage/        # Placeholder (mock data)
│                   ├── settings/       # Static form (no backend persistence)
│                   └── profile/        # User profile (read-only)
├── packages/shared/                    # @streampixel/shared (UserRole, ApiResponse, UserDto, AuthResponseDto)
├── infrastructure/
│   └── docker/
│       ├── docker-compose.yml          # Dev: postgres_db, backend, frontend
│       ├── docker-compose.prod.yml     # Production: production targets, EC2 IP hardcoded
│       └── setup-storage.sh            # Storage directory setup script
├── .env.example                        # Template with documented variables
├── tsconfig.base.json                  # Shared TS config (apps extend this)
└── package.json                        # Monorepo root (npm workspaces)
```

### How Streaming Works (the flow)

1. User uploads a packaged UE build ZIP via the dashboard
2. Backend extracts the ZIP to `/opt/streampixel/storage/projects/<id>/`
3. Backend scans for the UE executable (checks ELF magic bytes on Linux, .exe on Windows)
4. On "Start Instance":
   a. Allocates 3 ports (streamer, player, SFU) from range 8800-9100
   b. Spawns **Wilbur signaling server** (Epic Games, v2.3.1) on those ports
   c. Finds the UE build root (walks up from binary to find `Engine/` directory)
   d. Parses the `.sh` launcher script to extract the project name
   e. Spawns the **UE executable** wrapped in `xvfb-run -a` with flags:
      `ArchVizExplorer -RenderOffscreen -opengl -nosound -unattended`
      plus Pixel Streaming connection flags
   f. UE connects to Wilbur as a "streamer" via WebSocket
   g. Browser connects to Wilbur as a "player" via WebSocket
   h. Wilbur brokers WebRTC SDP exchange between UE and browser
   i. Direct WebRTC video/audio stream flows from UE → browser
5. Each project gets a unique `shareSlug` for public viewing (no auth required)
6. Public viewers auto-start the instance if not running

### Key Technology Stack

| Component | Tech |
|-----------|------|
| Backend | NestJS 10, Prisma 5.16, PostgreSQL 16, Passport JWT |
| Frontend | Next.js 14 (App Router), React 18, Tailwind CSS |
| Signaling | Epic Games Wilbur v2.3.1 (`@epicgames-ps/lib-pixelstreamingsignalling-ue5.5`) |
| Streaming Client | `@epicgames-ps/lib-pixelstreamingfrontend-ue5.5` |
| Container | Docker multi-stage builds, Docker Compose |
| Rendering | Mesa/lavapipe software Vulkan via Xvfb (no GPU) |
| Repo | GitHub: `saurabh106/streampixel`, branch: `development` |

---

## EC2 Deployment Details

- **Instance IP:** `13.201.4.220`
- **OS:** Ubuntu 24.04
- **Instance Type:** Non-GPU (no `/dev/dri/` device — likely `t3` or `m5`)
- **Docker:** Docker Compose production stack
- **Deploy path:** `/opt/streampixel`
- **Storage:** Docker volume `streampixel_storage` mounted at `/opt/streampixel/storage`
- **Dockerfile base:** `node:20-slim` (Debian bookworm) for production

### Ports Exposed
| Port | Service | Notes |
|------|---------|-------|
| 3000 | Frontend (Next.js) | Both dev and prod |
| 5000 | Backend (NestJS API) | Both dev and prod |
| 5434 | PostgreSQL (dev only) | `docker-compose.yml` maps 5434:5432. **Production** `docker-compose.prod.yml` does NOT expose PostgreSQL — only accessible within Docker network via `postgres_db:5432` |
| 8800-9100 | Signaling servers | Per instance (3 ports each: streamer, player, SFU) |

---

## What Has Been Built (WORKING)

### Backend
1. **Full monorepo** with npm workspaces — builds and runs correctly
2. **JWT authentication** — register, login, refresh token rotation, logout, `/auth/me`
3. **HTTPOnly refresh tokens** — opaque random hex (40 bytes), stored in PostgreSQL, set as HTTPOnly secure cookie
4. **Project upload** — ZIP/RAR upload (max 15GB), extraction, executable detection (ELF magic bytes on Linux, .exe on Windows)
5. **Database schema** — User, RefreshToken, Project, Instance models with Prisma migrations (3 migrations)
6. **Signaling server** — Epic Games Wilbur v2.3.1 embedded, spawns per-project with 3 dynamic ports (streamer, player, SFU)
7. **Port allocation** — Dynamic TCP port allocation from 8800-9100 range via bind test
8. **Post-spawn health check** — Detects UE crashes within 5 seconds (exit code check)
9. **Graceful signaling cleanup** — 5s grace period before killing signaling on UE crash
10. **Startup recovery** — `onModuleInit` probes all DB RUNNING instances; marks dead ones STOPPED
11. **Metrics polling** — 3s interval polls Wilbur `/status` for player count (informational only)
12. **Instance health endpoint** — `GET /projects/:id/health` for frontend crash detection polling
13. **Cross-platform process management** — Windows `taskkill /F /T` vs Linux `/proc` tree walk (SIGKILL bottom-up)
14. **Zone Identifier removal** — Windows Mark-of-the-Web stripping via PowerShell Unblock-File
15. **Share slug auto-generation** — Random 8-char slug with uniqueness check
16. **Swagger API docs** — Auto-generated at `/api/docs` with Bearer Auth support
17. **Response envelope** — All responses wrapped in `{ success, data, timestamp }` by `TransformInterceptor`
18. **Error envelope** — All errors wrapped in `{ success: false, error: { code, message, details }, timestamp }` by `HttpExceptionFilter`
19. **Validation** — `class-validator` decorators on DTOs, global `ValidationPipe` with whitelist+transform+forbidNonWhitelisted
20. **Common utilities** — `JwtAuthGuard`, `HttpExceptionFilter`, `TransformInterceptor`, `@GetUser()` decorator
21. **Legacy signaling server** — `signaling-server.ts` (265 lines, unused in production, retained for reference)

### Frontend
22. **Dashboard UI** — Sidebar navigation (6 items), mobile hamburger menu, user dropdown
23. **Project management** — List, upload modal (ZIP/RAR with progress bar), start/stop/delete
24. **PixelStreamPlayer component** — WebRTC viewer with retry logic (10x), 45s timeout, library preloading
25. **Canvas simulation fallback** — Animated 3D scene (particles, wireframe octahedron, HUD) when no UE executable
26. **Public share links** — `/watch/[shareSlug]` auto-starts instance, no auth required
27. **Axios auto-refresh** — Token refresh queue pattern: concurrent 401s share one refresh, then retry
28. **Auth context** — React Context with login, register, logout, refreshUser, isAuthenticated
29. **Next.js middleware** — Route guard: `/dashboard` requires `refresh_token` cookie
30. **Live CCU analytics** — Instances page polls every 3s for real-time viewer counts
31. **Stream viewer page** — Diagnostics panel, connection logs, health polling for crash detection
32. **Custom CSS design system** — `glass-card`, `glass-panel`, `glow-btn`, `ps-fullscreen`
33. **Tailwind custom theme** — Dark mode colors, glassmorphism tokens, accent colors

### Placeholder Pages (mock data, no backend)
34. **Deployments page** — Mock deployment data (Phase 2/3)
35. **Storage page** — Mock file archive data (Phase 2/3)
36. **Settings page** — Static form, no persistence (Phase 2/3)

### Infrastructure
37. **Docker Compose (dev)** — postgres_db, backend, frontend with volume mounts
38. **Docker Compose (prod)** — Production targets, EC2-specific IPs, no exposed PostgreSQL port
39. **Multi-stage Dockerfiles** — Both backend and frontend: development/builder/production stages
40. **Production Dockerfile (backend)** — Installs Vulkan, Mesa, xvfb, xauth, fontconfig for headless UE

---

## CURRENT STATE — Vulkan Architecture, UE 5.6+ Compatible

### Status: DEPLOYED & RUNNING

All fixes (build root, project name, Xvfb, Vulkan rendering, env vars, crash diagnostics) have been **committed, pushed, and deployed** with a full Docker rebuild on EC2.

### What We Fixed (All Deployed)

| # | Fix | Problem | Solution | Status |
|---|-----|---------|----------|--------|
| 1 | Build Root Detection (`findBuildRoot()`) | Wrong CWD (`Binaries/Linux/`) | Walk up to find `Engine/` directory | ✅ Deployed |
| 2 | Project Name Extraction (`parseLauncherScript()`) | Missing first arg to binary | Regex-match `.sh` launcher script | ✅ Deployed |
| 3 | Xvfb Virtual Display | No X11 display for rendering init | Manual Xvfb spawn on `:99` (no xvfb-run) | ✅ Deployed |
| 4 | Vulkan Rendering (`-vulkan`) | OpenGL deprecated in UE 5.6 | `-vulkan` with Mesa lavapipe software driver | ✅ Deployed |
| 5 | Explicit Environment Variables | Child process env inheritance | Pass `VK_ICD_FILENAMES`, `GALLIUM_DRIVER`, `MESA_LOADER_DRIVER_OVERRIDE`, etc. | ✅ Deployed |
| 6 | xauth Package (Dockerfile) | `xvfb-run` requires `xauth` | Added to `apt-get install` in Dockerfile | ✅ Deployed & Rebuilt |
| 7 | Crash Diagnostics (`-log`) | Shipping builds suppress all output | `-log` flag writes UE log files to `Saved/Logs/` | ✅ Deployed |

### Current Spawn Command (from `projects.service.ts:609-611`)
```
./ArchVizExplorer.sh \
  -unattended \
  -PixelStreamingSignallingURL=ws://127.0.0.1:8800 \
  -PixelStreamingEncoderCodec=H264 \
  -PixelStreamingWebRTCFps=60 \
  -PixelStreamingEncoderMinQP=1 \
  -PixelStreamingEncoderMaxQP=28 \
  -PixelStreamingEncoderTargetBitrate=20000 \
  -PixelStreamingEncoderMaxBitrate=50000 \
  -PixelStreamingEncoderRateControl=CBR \
  -ForceRes \
  -ResX=1920 \
  -ResY=1080 \
  -RenderOffscreen \
  -vulkan \
  -nosound \
  -log
```

Platform flags (`projects.service.ts:609-611`):
- **Linux:** `-RenderOffscreen`, `-vulkan`, `-nosound`, `-log`
- **Windows:** `-RenderOffscreen`, `-AudioMixer`, `-Windowed`, `-log`

Environment variables passed to UE process (`getUEEnvironment()`):
- `VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json` — Mesa lavapipe Vulkan ICD
- `GALLIUM_DRIVER=llvmpipe` — Software rasterizer
- `MESA_GL_VERSION_OVERRIDE=4.5` — GL version for compatibility
- `MESA_LOADER_DRIVER_OVERRIDE=lvp` — Force lavapipe driver
- `RADV_PERFTEST=gpl` — Enable GPL pipeline
- `DISPLAY=:99` — Virtual X display from Xvfb

### Log Output (After xauth Fix — Current State)
```
[ProjectsService] Spawning Unreal Engine executable: .../ArchVizExplorer-Linux-Shipping
[ProjectsService] UE build root (CWD): .../Linux
[ProjectsService] Parsed launcher script ArchVizExplorer.sh: project name = "ArchVizExplorer"
[ProjectsService] Parsed project name from launcher: ArchVizExplorer
[ProjectsService] UE launch args (linux): ArchVizExplorer -unattended ... -RenderOffscreen -opengl -nosound
[ProjectsService] Linux host: wrapping UE spawn with xvfb-run for virtual display
[ProjectsService] Successfully spawned UE process with PID 259
[ProjectsService] [UE-PID 259][stdout]: 5.6.1-44394996+++UE5+Release-5.6 1017 0
[ProjectsService] [UE-PID 259] UE process exited with code=1, signal=null. Marking instance as ERROR.
[ProjectsService] UE process health check failed: Unreal Engine process exited immediately after launch (exit code 1).
```

**Key observation:** xauth fix works — no more `xvfb-run: error: xauth command not found` (exit code 3). But UE now exits with **code 1** silently after printing its version banner.

---

## CURRENT ISSUE — UE 5.6.1 Silently Exits With Code 1

### What We Know

1. **Binary is valid:** `ldd` shows no missing shared libraries. Binary runs and prints version.
2. **Binary starts:** Prints `5.6.1-44394996+++UE5+Release-5.6 1017 0` then `Disabling core dumps.`
3. **Then silently exits** with code 1 — no error on stderr, no log files created
4. **No segfaults:** `dmesg` shows no kernel-level crashes or OOM kills
5. **No crash dumps:** No `.log`, `.dmp`, or `CrashReport*` files created anywhere under the project directory
6. **Shipping build:** The binary is a Shipping build which suppresses most stdout/stderr log output — errors go to files that are never created because the crash happens too early
7. **New fix:** `-log` flag now forces UE to write log files to `Saved/Logs/` — re-test should reveal the actual crash reason

### Manual Testing Results

| Test | Command | EXIT |
|------|---------|------|
| No xvfb-run, no flags | `DISPLAY=:99 ./binary ArchVizExplorer -unattended -RenderOffscreen -nosound` | 0 |
| With xvfb-run, no env vars | `xvfb-run -a ./binary ArchVizExplorer -unattended -RenderOffscreen -nosound` | 1 |
| With xvfb-run + DISPLAY=:99 | `DISPLAY=:99 xvfb-run -a ./binary ArchVizExplorer -unattended -RenderOffscreen -nosound` | 1 |
| With xvfb-run + Vulkan/Mesa env vars | `VK_ICD_FILENAMES=... GALLIUM_DRIVER=llvmpipe ... xvfb-run -a ./binary ...` | 1 |
| With xvfb-run + XDG_RUNTIME_DIR | `XDG_RUNTIME_DIR=/tmp/runtime-root xvfb-run -a ./binary ...` | 1 |
| With xvfb-run + full backend args | `xvfb-run -a ./binary ArchVizExplorer -unattended -PixelStreaming... -RenderOffscreen -opengl -nosound` | 1 |
| With timeout 15 + xvfb-run + full args | `timeout 15 xvfb-run -a ./binary ArchVizExplorer -unattended -PixelStreaming... -RenderOffscreen -opengl -nosound` | 1 |
| Without xvfb-run, no display, full args | Same args but `DISPLAY=:99` and no xvfb-run | 0 |

**Key finding:** The binary exits 0 when there's no X display running (can't render, just exits cleanly). It exits 1 when xvfb-run provides a real X display — meaning the crash happens during **OpenGL/rendering initialization**.

### Build Root Directory Structure
```
/opt/streampixel/storage/projects/Linux-1784691498882/Linux/
├── ArchVizExplorer/
│   ├── Binaries/Linux/ArchVizExplorer-Linux-Shipping (190MB, +x)
│   ├── Content/Paks/ (ArchVizExplorer-Linux.pak, .ucas, .utoc, global.ucas, .utoc)
│   └── Samples/PixelStreaming2/WebServers/
├── ArchVizExplorer.sh
├── Engine/
├── Manifest_NonUFSFiles_Linux.txt
└── Manifest_UFSFiles_Linux.txt
```

**Missing directories:** No `Config/`, no `Saved/Logs/` — UE may need these to initialize. Created `Saved/Logs/` and `Config/` manually but haven't tested yet.

---

## NEXT STEPS

### Immediate: Test With Created Directories

```bash
# Create required directories
sudo docker exec streampixel_backend sh -c "mkdir -p /opt/streampixel/storage/projects/Linux-1784691498882/Linux/Saved/Logs /opt/streampixel/storage/projects/Linux-1784691498882/Linux/Config && chown -R 1000:1000 /opt/streampixel/storage/projects/Linux-1784691498882/Linux/Saved /opt/streampixel/storage/projects/Linux-1784691498882/Linux/Config"

# Test with directories created
sudo docker exec -u 1000:1000 streampixel_backend sh -c "cd /opt/streampixel/storage/projects/Linux-1784691498882/Linux && timeout 15 xvfb-run -a ./ArchVizExplorer/Binaries/Linux/ArchVizExplorer-Linux-Shipping ArchVizExplorer -unattended -RenderOffscreen -nosound -log 2>&1; echo EXIT=\$?"
```

### If Still Failing — Root Cause Analysis

The crash happens during **OpenGL rendering initialization** inside xvfb-run. Possible causes:

1. **UE 5.6 dropped `-opengl` support** — UE5 has been transitioning to Vulkan-only. The `-opengl` flag might be silently rejected, causing the renderer to fail to initialize.
2. **Mesa/llvmpipe OpenGL 4.5 incompatibility** — UE 5.6 may require a higher GL version or specific extensions that llvmpipe doesn't provide.
3. **Missing Config/DefaultEngine.ini** — UE packaged builds sometimes need engine config to select the correct renderer.
4. **`-RenderOffscreen` + xvfb conflict** — Both try to handle display; they may conflict.

### Fallback Options

1. **Try `-vulkan` with xvfb-run** — If `-opengl` is broken in UE 5.6, `-vulkan` with Mesa's lavapipe driver might work:
   ```bash
   sudo docker exec -u 1000:1000 streampixel_backend sh -c "cd /opt/streampixel/storage/projects/Linux-1784691498882/Linux && timeout 15 xvfb-run -a ./ArchVizExplorer/Binaries/Linux/ArchVizExplorer-Linux-Shipping ArchVizExplorer -unattended -RenderOffscreen -vulkan -nosound -log 2>&1; echo EXIT=\$?"
   ```

2. **Run without xvfb-run** — If `-RenderOffscreen` is sufficient for UE 5.6, skip xvfb entirely:
   Modify `projects.service.ts` to spawn UE directly (no xvfb-run wrapper) on Linux.

3. **Build a debug image with strace** — Add `strace` to the Dockerfile to trace the exact system call that fails:
   ```dockerfile
   FROM streampixel_backend
   USER root
   RUN apt-get update && apt-get install -y strace && rm -rf /var/lib/apt/lists/*
   USER node
   ```

4. **Upgrade to GPU instance** — `g4dn.xlarge` (NVIDIA T4) eliminates all software rendering issues. Real GPU = real Vulkan/OpenGL.

5. **Test with a simpler UE project** — ArchVizExplorer has complex materials/shaders. A blank UE project or minimal build is more likely to work with software rendering.

---

## KEY FILES

### Backend
| File | Purpose |
|------|---------|
| `apps/backend/src/main.ts` | Bootstrap: Swagger, CORS, validation, global prefix `/api/v1` |
| `apps/backend/src/app.module.ts` | Root module (ConfigModule, Prisma, Users, Auth, Projects) |
| `apps/backend/src/projects/projects.service.ts` | **Core:** upload, extract, spawn UE + Wilbur (~1400 lines) |
| `apps/backend/src/projects/projects.controller.ts` | 7 JWT-guarded endpoints (upload, list, get, delete, start, stop, health, share-slug) |
| `apps/backend/src/projects/projects-public.controller.ts` | 1 public endpoint (get/auto-start by share slug) |
| `apps/backend/src/auth/auth.service.ts` | JWT auth: bcrypt, access tokens, refresh token rotation |
| `apps/backend/src/auth/auth.controller.ts` | 5 endpoints: register, login, logout, refresh, me |
| `apps/backend/src/auth/strategies/jwt.strategy.ts` | Passport JWT strategy (Bearer token extraction) |
| `apps/backend/src/common/guards/jwt-auth.guard.ts` | Passport JWT guard |
| `apps/backend/src/common/filters/http-exception.filter.ts` | Global error envelope |
| `apps/backend/src/common/interceptors/transform.interceptor.ts` | Global success envelope |
| `apps/backend/src/common/decorators/get-user.decorator.ts` | `@GetUser()` parameter decorator |
| `apps/backend/src/prisma/prisma.service.ts` | PrismaClient wrapper with lifecycle hooks |
| `apps/backend/prisma/schema.prisma` | DB schema: User, RefreshToken, Project, Instance |
| `apps/backend/Dockerfile` | Multi-stage: dev/builder/production (Vulkan, Mesa, xvfb, xauth) |
| `apps/backend/src/projects/signaling-server.ts` | Legacy custom WebSocket signaling (unused, retained for reference) |
| `apps/backend/src/projects/signaling/src/index.ts` | Embedded Epic Games Wilbur v2.3.1 entry point |

### Frontend
| File | Purpose |
|------|---------|
| `apps/frontend/src/services/api.ts` | Axios client: auto token refresh with queue pattern |
| `apps/frontend/src/hooks/useAuth.tsx` | React Context: login, register, logout, refreshUser |
| `apps/frontend/src/middleware.ts` | Route guard: `/dashboard` requires `refresh_token` cookie |
| `apps/frontend/src/components/PixelStreamPlayer.tsx` | WebRTC viewer + canvas simulation fallback (~494 lines) |
| `apps/frontend/src/app/dashboard/projects/page.tsx` | Project list, upload modal, start/stop/delete |
| `apps/frontend/src/app/dashboard/projects/[id]/stream/page.tsx` | Stream viewer + diagnostics panel + health polling |
| `apps/frontend/src/app/watch/[shareSlug]/page.tsx` | Public stream viewer (no auth, auto-starts instance) |
| `apps/frontend/src/app/dashboard/instances/page.tsx` | Live CCU analytics (polls every 3s) |
| `apps/frontend/src/app/globals.css` | Custom CSS: glass-card, glass-panel, glow-btn, ps-fullscreen |
| `apps/frontend/tailwind.config.ts` | Dark theme tokens, glassmorphism, accent colors |
| `apps/frontend/Dockerfile` | Multi-stage: dev/builder/production |

### Infrastructure
| File | Purpose |
|------|---------|
| `infrastructure/docker/docker-compose.yml` | Dev: postgres_db (5434:5432), backend, frontend |
| `infrastructure/docker/docker-compose.prod.yml` | Production: production targets, EC2 IP hardcoded |
| `packages/shared/src/index.ts` | Shared types: UserRole, ApiResponse, UserDto, AuthResponseDto |

### EC2 Paths
- Binary: `/opt/streampixel/storage/projects/Linux-1784691498882/Linux/ArchVizExplorer/Binaries/Linux/ArchVizExplorer-Linux-Shipping`
- Launcher: `/opt/streampixel/storage/projects/Linux-1784691498882/Linux/ArchVizExplorer.sh`
- Build root: `/opt/streampixel/storage/projects/Linux-1784691498882/Linux/`

---

## DATABASE SCHEMA (Prisma)

Source: `apps/backend/prisma/schema.prisma`

```prisma
model User {
  id            String         @id @default(uuid())
  email         String         @unique
  name          String?
  password      String
  role          Role           @default(USER)
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt
  refreshTokens RefreshToken[]
  projects      Project[]

  @@map("users")
}

model RefreshToken {
  id        String   @id @default(uuid())
  token     String   @unique
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  isRevoked Boolean  @default(false)
  createdAt DateTime @default(now())

  @@map("refresh_tokens")
}

model Project {
  id             String     @id @default(uuid())
  name           String
  version        String
  status         String     @default("STOPPED") // "RUNNING", "STOPPED"
  zipPath        String?
  extractedPath  String?
  executablePath String?
  userId         String
  user           User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  instances      Instance[]
  createdAt      DateTime   @default(now())
  updatedAt      DateTime   @updatedAt
  shareSlug      String?    @unique
  maxCCU         Int        @default(3)

  @@map("projects")
}

model Instance {
  id         String   @id @default(uuid())
  projectId  String
  project    Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  port       Int
  status     String   @default("STARTING") // "STARTING", "RUNNING", "STOPPED", "ERROR"
  pid        Int?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@map("instances")
}
```
