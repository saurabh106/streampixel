# StreamPixel — Current Status & Problem Statement

## What Is This Project?

StreamPixel is a SaaS platform for Unreal Engine Pixel Streaming. Users upload packaged UE builds (ZIP/RAR), and the platform streams them in-browser via WebRTC. Think of it as " GeForce NOW but self-hosted for your own UE projects."

## Architecture

```
EC2 Instance (Ubuntu 24.04, IP: 13.201.4.220)
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
   c. Spawns the **UE executable** with flags: `-PixelStreamingSignallingURL=ws://127.0.0.1:<streamerPort> -RenderOffscreen -vulkan -nosound`
   d. UE connects to Wilbur as a "streamer" via WebSocket
   e. Browser connects to Wilbur as a "player" via WebSocket
   f. Wilbur brokers WebRTC SDP exchange between UE and browser
   g. Direct WebRTC video/audio stream flows from UE → browser

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
10. **Post-spawn health check** — Detects UE crashes within 5 seconds (NEW)
11. **Frontend error handling** — Instance status polling, crash detection (NEW)
12. **Graceful signaling cleanup** — 5s grace period before killing signaling on UE crash (NEW)

---

## THE CURRENT PROBLEM

### Symptom
When clicking "Start Instance" on the dashboard, the UE process crashes immediately with **exit code 1** and **zero stdout/stderr output**.

### Error Shown to User
```
Unreal Engine process exited immediately after launch (exit code 1).
Ensure the packaged build is a valid Linux binary with Vulkan rendering support.
Check backend logs for [UE-PID xxx] output.
```

### What We've Diagnosed (step by step)

#### Attempt 1: `xdg-user-dir: not found`
- **Root cause:** UE binary calls `xdg-user-dir` at startup, which is in the `xdg-user-dirs` package (NOT `xdg-utils`)
- **Fix:** Added `xdg-user-dirs` to Dockerfile
- **Result:** Fixed that error, but UE still crashes with exit code 1

#### Attempt 2: No GPU device
- **EC2 instance has NO GPU** — `/dev/dri/` doesn't exist
- **Vulkan has no devices** — `vulkaninfo` shows the Vulkan loader works but there are zero GPU devices
- **Mesa lavapipe software renderer IS installed** — `lvp_icd.x86_64.json` exists at `/usr/share/vulkan/icd.d/`
- **Fix attempted:** Set `XDG_RUNTIME_DIR=/tmp/runtime-root`, `GALLIUM_DRIVER=llvmpipe`, `MESA_GL_VERSION_OVERRIDE=4.5` in Dockerfile, created `/tmp/runtime-root` with `chmod 1777`
- **Result:** UE binary still crashes with exit code 1 and ZERO output

#### Current State
The UE binary (`ArchVizExplorer-Linux-Shipping`) at path:
```
/opt/streampixel/storage/projects/Linux-1784691498882/Linux/ArchVizExplorer/Binaries/Linux/ArchVizExplorer-Linux-Shipping
```

- ✅ Is a valid Linux ELF binary (verified via `ldd` — all shared libraries resolve)
- ✅ Has execute permissions (`-rwxr-xr-x`)
- ✅ Runs as `node` user (UID 1000) inside container
- ✅ `xdg-user-dir` is now installed
- ✅ Mesa lavapipe ICD exists
- ✅ `XDG_RUNTIME_DIR` is set
- ❌ Produces ZERO stdout/stderr output
- ❌ Creates NO log files in `Saved/Logs/`
- ❌ Exits with code 1 within 1 second
- ❌ The `.uproject` file does NOT exist in the project directory (only `Binaries/`, `Content/`, `Samples/`)

### What We Know About the UE Build
```
/opt/streampixel/storage/projects/Linux-1784691498882/Linux/
├── ArchVizExplorer.sh          # Launcher script (calls the binary with project name arg)
├── ArchVizExplorer/
│   ├── Binaries/Linux/
│   │   ├── ArchVizExplorer-Linux-Shipping   # 190MB binary
│   │   ├── libNvmlWrapper.so
│   │   ├── libtbb.so / libtbb.so.12 / libtbb.so.12.13
│   │   └── libtbbmalloc.so / libtbbmalloc.so.2 / libtbbmalloc.so.2.13
│   ├── Content/                # Game content (pak files etc.)
│   └── Samples/                # Sample content
├── Engine/                     # UE engine files (vendored in build)
├── Manifest_NonUFSFiles_Linux.txt
└── Manifest_UFSFiles_Linux.txt
```

The `.sh` launcher script runs:
```bash
chmod +x "$UE_PROJECT_ROOT/ArchVizExplorer/Binaries/Linux/ArchVizExplorer-Linux-Shipping"
"$UE_PROJECT_ROOT/ArchVizExplorer/Binaries/Linux/ArchVizExplorer-Linux-Shipping" ArchVizExplorer "$@"
```

### How the Backend Spawns It
```typescript
const args = [
  '-unattended',
  `-PixelStreamingSignallingURL=ws://127.0.0.1:${streamerPort}`,
  `-PixelStreamingIP=127.0.0.1`,
  `-PixelStreamingPort=${streamerPort}`,
  '-PixelStreamingEncoderCodec=H264',
  '-RenderOffscreen',
  '-vulkan',
  '-nosound',
];
const spawnOptions = {
  cwd: path.dirname(absoluteExePath), // = .../Binaries/Linux/
};
ueProcess = spawn(absoluteExePath, args, spawnOptions);
```

### What We've Tried (Manual Testing Inside Container)

1. **Running from `Binaries/Linux/` directory** — Exit code 1, no output
2. **Running from `Linux/` directory (like the .sh script)** — Exit code 1, no output
3. **Passing `ArchVizExplorer` as first arg (like the .sh script)** — Exit code 1, no output
4. **strace** — Not available in `node:20-slim`, can't install (apt needs `libgcc-s1` dependency chain)

---

## LIKELY ROOT CAUSES TO INVESTIGATE

1. **Mesa lavapipe not initializing properly** — The env vars are set but the software Vulkan driver might need additional setup (e.g., `XDG_RUNTIME_DIR` pointing to an actual runtime dir with proper permissions, or a specific Mesa version that supports the Vulkan API version UE requires)

2. **UE Shipping build expects a `.uproject` file or specific directory structure** — Some UE builds require the project file to be discoverable relative to the binary

3. **UE needs a writable `Saved/` directory** — We created one but the binary might check for it before producing any output

4. **UE binary might need `DISPLAY` or X11 even with `-RenderOffscreen`** — Try with `xvfb-run` (Xvfb is installed in the Docker image)

5. **UE binary compiled with newer glibc than the container** — `ldd` resolves libraries but there could be version-specific symbol mismatches

6. **UE binary might need to run as root** — Some UE builds refuse to run as non-root, others refuse to run AS root. Currently runs as `node` (UID 1000).

7. **The `-vulkan` flag might be failing because Mesa lavapipe doesn't support the Vulkan API version UE expects** — UE 5.x typically needs Vulkan 1.1+, Mesa lavapipe on Debian bookworm should support this but might not

---

## SUGGESTED NEXT STEPS

1. **Try with `xvfb-run`** (virtual framebuffer is already installed):
   ```bash
   docker exec -w /opt/streampixel/storage/projects/Linux-1784691498882/Linux streampixel_backend \
     xvfb-run -a ./ArchVizExplorer/Binaries/Linux/ArchVizExplorer-Linux-Shipping \
     ArchVizExplorer -RenderOffscreen -vulkan -nosound -unattended \
     -PixelStreamingIP=127.0.0.1 -PixelStreamingPort=8800 2>&1
   ```

2. **Try with `-opengl` instead of `-vulkan`** (Mesa OpenGL works without Vulkan):
   Change the launch args in `projects.service.ts` to use `-opengl` instead of `-vulkan`

3. **Try running as root** (remove `USER node` or set `uid: 0` in compose):
   Some UE builds need root, but UE officially says it refuses to run as root. Conflicting info.

4. **Upgrade to a GPU EC2 instance** (g4dn.xlarge has NVIDIA T4):
   This would give real Vulkan support via NVIDIA drivers instead of relying on Mesa software rendering

5. **Check if this specific UE build (ArchVizExplorer) was actually packaged for Linux server/headless**:
   The "ArchVizExplorer" sample might require a GPU. A simpler UE project without complex materials/shaders might work better with software rendering.

6. **Get `strace` working** — Either build a debug Docker image with strace, or use `dmesg` / `journalctl` on the host to check for segfaults:
   ```bash
   dmesg | tail -20
   ```

---

## KEY FILES TO MODIFY

| File | What It Does |
|------|-------------|
| `apps/backend/src/projects/projects.service.ts:557-584` | UE launch args (flags, working directory, spawn options) |
| `apps/backend/src/projects/projects.service.ts:605-668` | UE process spawn + exit handler + health check |
| `apps/backend/Dockerfile:26-39` | Production image packages + env vars for rendering |
| `infrastructure/docker/docker-compose.prod.yml:18-40` | Backend service config (ports, volumes, env) |
| `apps/frontend/src/components/PixelStreamPlayer.tsx` | WebRTC viewer with retry logic |
| `apps/frontend/src/app/dashboard/projects/[id]/stream/page.tsx` | Stream page with instance health polling |

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
