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

## CURRENT STATE — xauth Fixed, UE Exits With Code 1

### Status: DEPLOYED & RUNNING

All previous fixes (build root, project name, xvfb-run, opengl, env vars, xauth) have been **committed, pushed, and deployed** with a full Docker rebuild on EC2.

### What We Fixed (All Deployed)

| # | Fix | Problem | Solution | Status |
|---|-----|---------|----------|--------|
| 1 | Build Root Detection (`findBuildRoot()`) | Wrong CWD (`Binaries/Linux/`) | Walk up to find `Engine/` directory | ✅ Deployed |
| 2 | Project Name Extraction (`parseLauncherScript()`) | Missing first arg to binary | Regex-match `.sh` launcher script | ✅ Deployed |
| 3 | xvfb-run Wrapper | No X11 display for OpenGL init | `xvfb-run -a` wraps UE spawn | ✅ Deployed |
| 4 | OpenGL Instead of Vulkan | `-vulkan` needs real GPU | `-opengl` for Mesa/llvmpipe | ✅ Deployed |
| 5 | Explicit Environment Variables | Child process env inheritance | Pass `VK_ICD_FILENAMES`, `GALLIUM_DRIVER`, etc. | ✅ Deployed |
| 6 | xauth Package (Dockerfile) | `xvfb-run` requires `xauth` | Added to `apt-get install` in Dockerfile | ✅ Deployed & Rebuilt |

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

1. **Binary is valid:** `ldd` shows no missing shared libraries. `file` command not available in container but binary runs and prints version.
2. **Binary starts:** Prints `5.6.1-44394996+++UE5+Release-5.6 1017 0` then `Disabling core dumps.`
3. **Then silently exits** with code 1 — no error on stderr, no log files created
4. **No segfaults:** `dmesg` shows no kernel-level crashes or OOM kills
5. **No crash dumps:** No `.log`, `.dmp`, or `CrashReport*` files created anywhere under the project directory
6. **Shipping build:** The binary is a Shipping build which suppresses most stdout/stderr log output — errors go to files that are never created because the crash happens too early

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
