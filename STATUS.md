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
│   ├── backend/              # NestJS API server
│   │   ├── src/
│   │   │   ├── auth/         # JWT auth (register, login, refresh, logout)
│   │   │   ├── users/        # User CRUD
│   │   │   ├── projects/     # CORE: upload, extract, spawn UE + Wilbur signaling
│   │   │   └── prisma/       # Prisma ORM
│   │   ├── prisma/schema.prisma  # 4 models: User, RefreshToken, Project, Instance
│   │   └── Dockerfile        # Multi-stage: dev/builder/production
│   └── frontend/             # Next.js 14 (App Router)
│       ├── src/app/dashboard/  # Authenticated UI (projects, stream, instances)
│       ├── src/app/watch/      # Public share links
│       ├── src/components/PixelStreamPlayer.tsx  # WebRTC viewer
│       └── Dockerfile          # Multi-stage: dev/builder/production
└── packages/shared/          # Shared TypeScript types
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
| Rendering | Mesa/llvmpipe software OpenGL via `xvfb-run` (no GPU) |
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
| Port | Service |
|------|---------|
| 3000 | Frontend (Next.js) |
| 5000 | Backend (NestJS API) |
| 5434 | PostgreSQL |
| 8800-9100 | Signaling servers (per instance, 3 ports each) |

---

## What Has Been Built (WORKING)

1. **Full monorepo** with npm workspaces — builds and runs correctly
2. **JWT authentication** — register, login, refresh tokens, logout
3. **Project upload** — ZIP/RAR upload, extraction, executable detection (ELF magic bytes for Linux)
4. **Database schema** — User, RefreshToken, Project, Instance models with Prisma migrations
5. **Signaling server** — Epic Games Wilbur embedded, spawns per-project with dynamic ports
6. **Port allocation** — Dynamic TCP port allocation from 8800-9100 range
7. **Frontend UI** — Dashboard with project management, upload modal, stream viewer, public share links
8. **PixelStreamPlayer component** — WebRTC viewer with retry logic, simulation fallback
9. **Docker Compose** — Dev and production configurations with multi-stage Dockerfiles
10. **Post-spawn health check** — Detects UE crashes within 5 seconds
11. **Frontend error handling** — Instance status polling, crash detection with descriptive messages
12. **Graceful signaling cleanup** — 5s grace period before killing signaling on UE crash
13. **UE stdout logging** — Promoted from DEBUG to LOG level for visibility
14. **Instance health endpoint** — `GET /projects/:id/health` for frontend polling

---

## CURRENT STATE — UE Spawn Fixes (Deployed)

### What We Fixed in `projects.service.ts`

All of the following fixes have been **committed, pushed, and deployed** (as of latest Docker rebuild):

#### Fix 1: Build Root Detection (`findBuildRoot()`)
- **Problem:** Backend used `path.dirname(absoluteExePath)` which resolves to `.../Binaries/Linux/` — the wrong CWD
- **Solution:** New `findBuildRoot()` method walks up from the binary's directory looking for a directory containing `Engine/`
- **Result:** CWD is now `.../Linux/` (the actual UE build root), matching what the `.sh` launcher expects
- **Log confirmation:** `UE build root (CWD): /opt/streampixel/storage/projects/Linux-1784691498882/Linux`

#### Fix 2: Project Name Extraction (`parseLauncherScript()`)
- **Problem:** Backend didn't pass the project name as the first argument. The `.sh` script does: `binary ArchVizExplorer "$@"`. Without this, UE doesn't know which uproject to load.
- **Solution:** New `parseLauncherScript()` method reads `.sh` files in the build root and regex-matches the `Binaries... <ProjectName>` pattern
- **Result:** `ArchVizExplorer` is now passed as the first positional arg
- **Log confirmation:** `Parsed launcher script ArchVizExplorer.sh: project name = "ArchVizExplorer"`

#### Fix 3: xvfb-run Wrapper
- **Problem:** UE binary (even with `-RenderOffscreen`) may need an X11 display context for OpenGL initialization
- **Solution:** On Linux, UE is now spawned via `xvfb-run -a <binary> <args>` instead of directly. `-a` auto-selects a free display number.
- **Result:** Provides a virtual X display for the OpenGL context
- **Log confirmation:** `Linux host: wrapping UE spawn with xvfb-run for virtual display`

#### Fix 4: OpenGL Instead of Vulkan (`-opengl` replacing `-vulkan`)
- **Problem:** `-vulkan` requires a real GPU or a fully functional Vulkan driver. The EC2 instance has no GPU, and Mesa lavapipe may not initialize properly.
- **Solution:** Replaced `-vulkan` with `-opengl` — works with Mesa/llvmpipe software rendering on no-GPU instances
- **Result:** UE should use software OpenGL rendering via Mesa

#### Fix 5: Explicit Environment Variables
- **Problem:** Child processes spawned via `xvfb-run` might not inherit all container env vars
- **Solution:** All Mesa/Vulkan/GL env vars are now passed explicitly in `spawnOptions.env`:
  - `VK_ICD_FILENAMES`, `GALLIUM_DRIVER=llvmpipe`, `MESA_GL_VERSION_OVERRIDE=4.5`, `DISPLAY=:99`

#### Fix 6: xauth Package (Dockerfile)
- **Problem:** `xvfb-run` requires `xauth` which wasn't installed in `node:20-slim`
- **Solution:** Added `xauth` to the apt-get install line in the Dockerfile
- **Status:** Committed and pushed, awaiting Docker rebuild on EC2

### Current Spawn Command
```
xvfb-run -a /opt/streampixel/storage/projects/Linux-1784691498882/Linux/ArchVizExplorer/Binaries/Linux/ArchVizExplorer-Linux-Shipping \
  ArchVizExplorer \
  -unattended \
  -PixelStreamingSignallingURL=ws://127.0.0.1:8800 \
  -PixelStreamingIP=127.0.0.1 \
  -PixelStreamingPort=8800 \
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
  -opengl \
  -nosound
```

### Log Output from Last Successful Deploy (before xauth error)
```
[ProjectsService] Spawning Unreal Engine executable: .../ArchVizExplorer-Linux-Shipping
[ProjectsService] UE build root (CWD): .../Linux
[ProjectsService] Parsed launcher script ArchVizExplorer.sh: project name = "ArchVizExplorer"
[ProjectsService] Parsed project name from launcher: ArchVizExplorer
[ProjectsService] UE launch args (linux): ArchVizExplorer -unattended ... -RenderOffscreen -opengl -nosound
[ProjectsService] Linux host: wrapping UE spawn with xvfb-run for virtual display
[ProjectsService] Successfully spawned UE process with PID 74
[ProjectsService] [UE-PID 74][stderr]: xvfb-run: error: xauth command not found
[ProjectsService] [UE-PID 74] UE process exited with code=3, signal=null
```

**Exit code 3** is from `xvfb-run` itself (not from UE) — it can't run without `xauth`. The `xauth` fix is committed but the Docker image hasn't been rebuilt yet.

---

## NEXT STEP — Rebuild Docker Image

The `xauth` package fix is committed and pushed. Run on EC2:

```bash
cd /opt/streampixel
git pull origin development
cd infrastructure/docker
sudo docker compose -f docker-compose.prod.yml build backend --no-cache
sudo docker compose -f docker-compose.prod.yml up -d backend
```

Then start the instance and check logs:
```bash
sudo docker compose -f docker-compose.prod.yml logs -f backend
```

**Expected outcome:** If `xvfb-run` succeeds, UE should start and either:
- Begin outputting logs to stdout/stderr (if software rendering works)
- Or crash with a different exit code that gives us more diagnostic info

---

## IF UE STILL CRASHES AFTER xauth FIX

### Fallback Options

1. **Run without xvfb-run** — Add a flag to skip xvfb-run and spawn UE directly with `-opengl -RenderOffscreen`:
   Some UE builds work without an X display when `-RenderOffscreen` is set

2. **Try `-vulkan` with xvfb-run** — If `-opengl` doesn't work with this particular UE build, try reverting to `-vulkan` now that xvfb provides a display

3. **Check `dmesg` on EC2 host** — Look for segfaults or OOM kills:
   ```bash
   sudo dmesg | tail -20
   ```

4. **Debug Docker image** — Build a temporary image with `strace`:
   ```dockerfile
   FROM streampixel_backend
   USER root
   RUN apt-get update && apt-get install -y strace && rm -rf /var/lib/apt/lists/*
   USER node
   ```
   Then run: `strace -f -o /tmp/ue_strace.log <binary> <args>`

5. **Upgrade to GPU instance** — `g4dn.xlarge` has NVIDIA T4 with real Vulkan support. This eliminates all software rendering issues.

6. **Test with a simpler UE project** — ArchVizExplorer has complex materials/shaders that may not work with software rendering. A blank UE project or one with minimal shaders is more likely to work.

---

## KEY FILES

| File | Purpose |
|------|---------|
| `apps/backend/src/projects/projects.service.ts` | Core UE spawn logic (build root, project name, xvfb-run, args) |
| `apps/backend/src/projects/projects.controller.ts` | Health endpoint |
| `apps/backend/Dockerfile` | Production image (packages, env vars, xvfb, xauth) |
| `infrastructure/docker/docker-compose.prod.yml` | Backend service config (ports, volumes, env) |
| `apps/frontend/src/components/PixelStreamPlayer.tsx` | WebRTC viewer with retry logic |
| `apps/frontend/src/app/dashboard/projects/[id]/stream/page.tsx` | Stream page with health polling |
| `apps/frontend/src/app/watch/[shareSlug]/page.tsx` | Public viewer page |

### EC2 Paths
- Binary: `/opt/streampixel/storage/projects/Linux-1784691498882/Linux/ArchVizExplorer/Binaries/Linux/ArchVizExplorer-Linux-Shipping`
- Launcher: `/opt/streampixel/storage/projects/Linux-1784691498882/Linux/ArchVizExplorer.sh`
- Build root: `/opt/streampixel/storage/projects/Linux-1784691498882/Linux/`

---

## DATABASE SCHEMA (Prisma)

```prisma
model User {
  id           String         @id @default(uuid())
  email        String         @unique
  name         String?
  password     String
  role         Role           @default(USER)
  createdAt    DateTime       @default(now())
  updatedAt    DateTime       @updatedAt
  projects     Project[]
  refreshTokens RefreshToken[]
}

model RefreshToken {
  id        String   @id @default(uuid())
  token     String   @unique
  userId    String
  expiresAt DateTime
  isRevoked Boolean  @default(false)
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model Project {
  id             String     @id
  name           String
  version        String
  status         String     @default("STOPPED")
  zipPath        String
  extractedPath  String
  executablePath String?
  shareSlug      String     @unique
  maxCCU         Int        @default(3)
  userId         String
  createdAt      DateTime   @default(now())
  updatedAt      DateTime   @updatedAt
  user           User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  instances      Instance[]
}

model Instance {
  id        String   @id @default(uuid())
  projectId String
  port      Int
  status    String   @default("STARTING")
  pid       Int?
  createdAt DateTime @default(now())
  project   Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
}
```
