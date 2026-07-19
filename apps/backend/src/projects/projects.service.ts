import {
  Injectable,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, execSync } from 'child_process';
import unzipper from 'unzipper';
import { createExtractorFromFile } from 'node-unrar-js';

@Injectable()
export class ProjectsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectsService.name);
  // Instance lifecycle is fully decoupled from WebSocket/browser connections.
  // Once started, an instance runs until explicitly stopped via stopInstance().
  // Player count is tracked for display only — zero players never triggers shutdown.
  private activeProcesses = new Map<
    string,
    {
      signalingProcess?: any;
      ueProcess?: any;
      playerPort: number;
      streamerPort: number;
      clients: number;
      ownerId: string;
    }
  >();
  // Storage root: configurable via STORAGE_PATH env var.
  // Defaults to /opt/streampixel/store on Linux, ./storage on other platforms.
  private storagePath =
    process.env.STORAGE_PATH ||
    (process.platform === 'linux'
      ? '/opt/streampixel/store'
      : path.resolve(process.cwd(), 'storage'));

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    // Ensure storage folders exist
    const projectsDir = path.join(this.storagePath, 'projects');
    if (!fs.existsSync(projectsDir)) {
      fs.mkdirSync(projectsDir, { recursive: true });
      this.logger.log(`Created projects storage directory at ${projectsDir}`);
    }

    // On backend restart, check each RUNNING instance's signaling server port.
    // If still responsive, the UE process and Wilbur are alive — leave the DB record as-is
    // so the public share link continues to work without re-spawning.
    // If NOT responsive, the processes died — mark as STOPPED so getByShareSlug
    // will auto-start a fresh instance on next access.
    this.prisma.instance
      .findMany({ where: { status: 'RUNNING' } })
      .then(async (instances) => {
        let resetCount = 0;
        let keptCount = 0;
        for (const instance of instances) {
          const alive = await this.checkPortStatus(instance.port, 2000);
          if (alive) {
            keptCount++;
            this.logger.log(
              `Instance ${instance.id} on port ${instance.port} is still alive — keeping RUNNING`,
            );
          } else {
            await this.prisma.instance
              .update({ where: { id: instance.id }, data: { status: 'STOPPED' } })
              .catch(() => {});
            await this.prisma.project
              .update({ where: { id: instance.projectId }, data: { status: 'STOPPED' } })
              .catch(() => {});
            resetCount++;
          }
        }
        this.logger.log(
          `Startup instance check: ${keptCount} kept alive, ${resetCount} marked STOPPED`,
        );
      })
      .catch((err) => {
        this.logger.error(`Failed to check instance states on startup: ${err.message}`);
      });

    this.startMetricsPolling();
  }

  async onModuleDestroy() {
    this.logger.log('Shutting down. Cleaning up all active processes...');
    for (const [projectId, proc] of this.activeProcesses.entries()) {
      if (proc.ueProcess && proc.ueProcess.pid) {
        this.logger.log(`Killing UE process PID ${proc.ueProcess.pid}`);
        this.killProcessTree(proc.ueProcess.pid);
      }
      if (proc.signalingProcess && proc.signalingProcess.pid) {
        this.logger.log(`Killing Signaling process PID ${proc.signalingProcess.pid}`);
        this.killProcessTree(proc.signalingProcess.pid);
      }
    }
  }

  async create(file: Express.Multer.File, name: string, version: string, userId: string) {
    if (!file) {
      throw new BadRequestException('Unreal Engine project ZIP file is required');
    }

    const projectId =
      path.parse(file.originalname).name.replace(/[^a-zA-Z0-9_-]/g, '') + '-' + Date.now();
    const projectDir = path.join(this.storagePath, 'projects', projectId);

    // Create project directory
    fs.mkdirSync(projectDir, { recursive: true });

    const zipPath = path.join(projectDir, file.originalname);
    fs.writeFileSync(zipPath, file.buffer);

    // Save temporary record to DB
    const shareSlug = Math.random().toString(36).substring(2, 10);
    const project = await this.prisma.project.create({
      data: {
        id: projectId,
        name,
        version,
        status: 'STOPPED',
        zipPath,
        extractedPath: projectDir,
        userId,
        shareSlug,
        maxCCU: 3,
      },
    });

    // Extract archive (ZIP or RAR)
    try {
      const isRar = file.originalname.toLowerCase().endsWith('.rar');
      if (isRar) {
        this.logger.log(`Extracting project RAR: ${zipPath}`);
        const extractor = await createExtractorFromFile({
          filepath: zipPath,
          targetPath: projectDir,
        });
        const extracted = extractor.extract();
        let fileCount = 0;
        for (const entry of extracted.files) {
          fileCount++;
          if (fileCount <= 5) {
            this.logger.debug(`Extracted: ${entry.fileHeader.name}`);
          }
        }
        this.logger.log(`RAR extraction complete — ${fileCount} files extracted to ${projectDir}`);
      } else {
        this.logger.log(`Extracting project ZIP: ${zipPath}`);
        const directory = await unzipper.Open.file(zipPath);
        const entryCount = directory.files.filter((f) => f.type === 'File').length;
        this.logger.log(`ZIP archive contains ${entryCount} files. Starting extraction...`);
        await directory.extract({
          path: projectDir,
          concurrency: 5,
        });
        this.logger.log(
          `ZIP extraction complete — ${entryCount} files extracted to ${projectDir}`,
        );
      }

      // Search for executable
      this.logger.log(`Scanning extracted project for Unreal Engine executable...`);
      const exeFullPath = this.findExecutable(projectDir);
      if (exeFullPath) {
        const relativeExePath = path.relative(projectDir, exeFullPath);
        await this.prisma.project.update({
          where: { id: projectId },
          data: { executablePath: relativeExePath },
        });
        this.logger.log(
          `✅ Executable found and saved: ${relativeExePath} (absolute: ${exeFullPath})`,
        );
      } else {
        this.logger.warn(
          `No valid executable found in the extracted project archive. ` +
            `The project directory was scanned recursively (excluding Engine/ subfolders) ` +
            `but no project executable was detected. ` +
            `On Linux, ensure the binary has the execute permission bit set. ` +
            `You will need to re-upload with a build that contains the project binary at the expected location.`,
        );
      }
    } catch (error) {
      this.logger.error(`Failed to extract or scan archive for ${projectId}: ${error.message}`);
      // Clean up failed extraction directory
      try {
        if (fs.existsSync(projectDir)) {
          fs.rmSync(projectDir, { recursive: true, force: true });
        }
      } catch (cleanupErr) {
        this.logger.error(`Failed to clean up failed extraction: ${cleanupErr.message}`);
      }
      throw new BadRequestException(
        `Failed to extract project archive: ${error.message}. Please ensure the file is a valid ZIP or RAR archive.`,
      );
    }

    return this.prisma.project.findUnique({
      where: { id: projectId },
    });
  }

  async findAll(userId: string) {
    const projects = await this.prisma.project.findMany({
      where: { userId },
      include: { instances: true },
      orderBy: { createdAt: 'desc' },
    });

    return projects.map((p) => {
      const proc = this.activeProcesses.get(p.id);
      return {
        ...p,
        clients: proc ? proc.clients : 0,
      };
    });
  }

  async findOne(id: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
      include: { instances: true },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    const proc = this.activeProcesses.get(project.id);
    return {
      ...project,
      clients: proc ? proc.clients : 0,
    };
  }

  async getByShareSlug(shareSlug: string) {
    const project = await this.prisma.project.findUnique({
      where: { shareSlug },
      include: { instances: true },
    });

    if (!project) {
      throw new NotFoundException(`Project not found`);
    }

    // Check if there is already a running instance.
    // onModuleInit validates instance health at startup and marks dead ones STOPPED,
    // so any instance still RUNNING in the DB is genuinely alive — no per-request
    // port probe needed. This keeps the fast path (instance already running) down to
    // a single DB query with no network I/O.
    const activeInstance = project.instances?.find((i) => i.status === 'RUNNING');
    if (activeInstance) {
      return {
        id: project.id,
        name: project.name,
        version: project.version,
        status: 'RUNNING',
        port: activeInstance.port,
        isSimulated: false,
      };
    }

    // No running instance — auto-start one for this viewer.
    // Cold-start minimum: Wilbur bind (~1s) + UE process launch (~3-8s depending
    // on the build) + WebRTC handshake (~0.5s) ≈ 5-10s total.
    const startResult = await this.startInstance(project.id, project.userId);

    return {
      id: project.id,
      name: project.name,
      version: project.version,
      status: 'RUNNING',
      port: startResult.port,
      isSimulated: false,
    };
  }

  async delete(id: string, userId: string) {
    const project = await this.findOne(id, userId);

    // Stop if running
    if (project.status === 'RUNNING') {
      await this.stopInstance(id, userId);
    }

    // Clean files
    try {
      if (project.extractedPath && fs.existsSync(project.extractedPath)) {
        fs.rmSync(project.extractedPath, { recursive: true, force: true });
      }
    } catch (e) {
      this.logger.error(`Failed to clean up files for ${id}: ${e.message}`);
    }

    await this.prisma.project.delete({
      where: { id },
    });

    return { success: true };
  }

  async startInstance(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    // If already running
    const existingInstance = await this.prisma.instance.findFirst({
      where: { projectId, status: 'RUNNING' },
    });

    const activeProc = this.activeProcesses.get(projectId);

    if (existingInstance && activeProc) {
      return {
        message: 'Instance is already running',
        port: activeProc.playerPort,
        status: existingInstance.status,
        isSimulated: false,
      };
    }

    // If DB has a RUNNING record but the process is not in memory
    // (e.g. server restarted), clean up the stale record first
    if (existingInstance && !activeProc) {
      this.logger.warn(
        `Found stale RUNNING instance ${existingInstance.id} on port ${existingInstance.port} ` +
          `with no active process. Cleaning up before starting fresh.`,
      );
      await this.prisma.instance
        .update({
          where: { id: existingInstance.id },
          data: { status: 'STOPPED' },
        })
        .catch(() => {});
    }

    // Allocate free ports starting from 8800
    const streamerPort = await this.findFreePort(8800, 8900);
    const playerPort = await this.findFreePort(streamerPort + 1, 9000);
    const sfuPort = await this.findFreePort(playerPort + 1, 9100);
    this.logger.log(
      `Allocated streamerPort ${streamerPort}, playerPort ${playerPort}, sfuPort ${sfuPort} for project ${project.name}`,
    );

    // NOTE: No OS-level firewall rules (e.g. netsh advfirewall on Windows) are managed here.
    // Inbound port access is handled at the infrastructure layer — cloud provider security groups,
    // iptables/nftables, or network policies — not by this application process.
    // The signaling server (Wilbur) binds to 0.0.0.0 by default and expects the network layer
    // to control external reachability of the allocated ports.

    // Verify signaling server is built before spawning
    const signalingDir = this.getSignalingDir();
    const jsPath = path.resolve(signalingDir, 'dist', 'index.js');
    if (!fs.existsSync(jsPath)) {
      throw new BadRequestException(
        `Signaling server not built. Expected ${jsPath} to exist. Run 'npm run build' in the signaling directory.`,
      );
    }
    this.logger.log(
      `Spawning Epic Games signaling server on streamerPort ${streamerPort}, playerPort ${playerPort}`,
    );

    const maxPlayers = project.maxCCU || 3;
    const signalingArgs = [
      jsPath,
      '--no_config',
      '--streamer_port',
      streamerPort.toString(),
      '--player_port',
      playerPort.toString(),
      '--sfu_port',
      sfuPort.toString(),
      '--max_players',
      maxPlayers.toString(),
      '--console_messages',
      'verbose',
      '--rest_api',
      '--serve',
      '--cors',
    ];

    let signalingProcess: any;
    try {
      signalingProcess = spawn('node', signalingArgs, {
        cwd: signalingDir,
      });

      // Capture logs to NestJS Logger
      signalingProcess.stdout?.on('data', (data: any) => {
        this.logger.debug(`[Signaling-PID ${signalingProcess.pid}]: ${data.toString().trim()}`);
      });
      signalingProcess.stderr?.on('data', (data: any) => {
        this.logger.error(`[Signaling-PID ${signalingProcess.pid}]: ${data.toString().trim()}`);
      });

      this.logger.log(`Signaling server process spawned with PID ${signalingProcess.pid}`);
    } catch (err) {
      this.logger.error(`Failed to spawn signaling server: ${err.message}`);
      throw new BadRequestException(`Failed to spawn signaling server: ${err.message}`);
    }

    // Wait for the signaling server player port to become active
    this.logger.log(`Waiting for signaling server to bind to playerPort ${playerPort}...`);
    const isSignalingReady = await this.checkPortStatus(playerPort, 5000);
    if (!isSignalingReady) {
      this.logger.error(`Signaling server failed to start on port ${playerPort} in time`);
      if (signalingProcess && signalingProcess.pid) {
        this.killProcessTree(signalingProcess.pid);
      }
      throw new BadRequestException('Signaling server health check failed on playerPort');
    }
    this.logger.log(
      `Signaling server TCP port ${playerPort} is bound. Verifying HTTP handler is ready...`,
    );

    // Quick HTTP readiness check — Wilbur typically responds within a few hundred ms
    const httpReady = await this.checkHttpReady(playerPort, 3000);
    if (!httpReady) {
      this.logger.warn(
        `Signaling server HTTP handler not ready on port ${playerPort}, proceeding anyway`,
      );
    } else {
      this.logger.log(`Signaling server HTTP handler confirmed ready on port ${playerPort}`);
    }

    let ueProcess: any;
    let pid: number;

    if (!project.executablePath || !project.extractedPath) {
      // No executable was detected during upload — this is a hard error, not a simulation fallback
      this.logger.error(
        `Project "${project.name}" has no executablePath recorded. ` +
          `The upload scan did not find a valid executable in the archive. ` +
          `Ensure your packaged build folder contains the project binary at its expected location.`,
      );
      // Clean up the signaling server we just spawned
      if (signalingProcess && signalingProcess.pid) {
        this.killProcessTree(signalingProcess.pid);
      }
      throw new BadRequestException(
        `No Unreal Engine executable found in project "${project.name}". ` +
          `Ensure your packaged build contains a project binary at the root level of the archive (not inside Engine/). ` +
          `On Linux, the binary must also have the execute permission bit set. ` +
          `The uploaded archive was scanned and no valid project executable was detected.`,
      );
    }

    const absoluteExePath = path.resolve(project.extractedPath, project.executablePath);
    if (!fs.existsSync(absoluteExePath)) {
      this.logger.error(
        `Executable path recorded as "${project.executablePath}" but file does not exist at ${absoluteExePath}`,
      );
      if (signalingProcess && signalingProcess.pid) {
        this.killProcessTree(signalingProcess.pid);
      }
      throw new BadRequestException(
        `Executable file not found at expected path: ${project.executablePath}. ` +
          `The file may have been moved or deleted after upload.`,
      );
    }

    this.logger.log(`Spawning Unreal Engine executable: ${absoluteExePath}`);
    this.logger.log(`UE launch dir: ${path.dirname(absoluteExePath)}`);

    // PixelStreaming2 launch flags (UE 5.4+)
    // -PixelStreamingSignallingURL is the single-flag connection string for PixelStreaming2
    // Falls back to -PixelStreamingIP/-PixelStreamingPort for older plugin versions
    //
    // Platform-specific notes:
    // - Linux headless: uses Vulkan renderer (-vulkan), no window system (-RenderOffscreen),
    //   no audio device (-nosound). D3D12 is not available on Linux.
    // - Windows: uses D3D12 by default, -Windowed for offscreen rendering.
    const commonArgs = [
      `-PixelStreamingSignallingURL=ws://127.0.0.1:${streamerPort}`,
      `-PixelStreamingIP=127.0.0.1`,
      `-PixelStreamingPort=${streamerPort}`,
      '-PixelStreamingEncoderCodec=H264',
      '-PixelStreamingWebRTCFps=60',
      '-PixelStreamingEncoderMinQP=1',
      '-PixelStreamingEncoderMaxQP=28',
      '-PixelStreamingEncoderTargetBitrate=20000',
      '-PixelStreamingEncoderMaxBitrate=50000',
      '-PixelStreamingEncoderRateControl=CBR',
      '-ForceRes',
      '-ResX=1920',
      '-ResY=1080',
    ];

    const platformArgs = this.isLinux
      ? [
          '-RenderOffscreen', // No display server required — renders to offscreen buffer
          '-vulkan', // Vulkan is the Linux-native GPU API (D3D12 is Windows-only)
          '-nosound', // Headless servers lack PulseAudio/ALSA; avoids device init failures
        ]
      : [
          '-AudioMixer', // Windows: required for the audio subsystem to initialize properly
          '-RenderOffscreen',
          '-Windowed', // Windows: create a hidden window for the D3D12 rendering context
        ];

    const args = [...commonArgs, ...platformArgs];
    this.logger.log(`UE launch args (${process.platform}): ${args.join(' ')}`);

    try {
      ueProcess = spawn(absoluteExePath, args, {
        cwd: path.dirname(absoluteExePath),
      });

      // Capture UE process stdout/stderr for debugging
      ueProcess.stdout?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          this.logger.debug(`[UE-PID ${ueProcess.pid}][stdout]: ${msg}`);
        }
      });
      ueProcess.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          this.logger.warn(`[UE-PID ${ueProcess.pid}][stderr]: ${msg}`);
        }
      });

      ueProcess.on('error', (err: Error) => {
        this.logger.error(`[UE-PID ${ueProcess.pid}] Process error: ${err.message}`);
      });

      ueProcess.on('exit', (code: number | null, signal: string | null) => {
        this.logger.log(
          `[UE-PID ${ueProcess.pid}] Process exited with code=${code}, signal=${signal}`,
        );
      });

      pid = ueProcess.pid;
      if (!pid) {
        throw new Error('UE process spawned but PID is null/undefined');
      }
      this.logger.log(`Successfully spawned UE process with PID ${pid}`);
    } catch (err: any) {
      this.logger.error(`Failed to spawn Unreal Engine process: ${err.message}`);
      if (signalingProcess && signalingProcess.pid) {
        this.killProcessTree(signalingProcess.pid);
      }
      throw new BadRequestException(
        `Failed to launch Unreal Engine executable: ${err.message}. ` +
          `Ensure the binary is a valid ${this.isLinux ? 'Linux ELF' : 'Windows'} executable and not corrupted.`,
      );
    }

    // Save processes in memory map
    // Instance lifecycle is decoupled from any browser/WebSocket connection:
    // closing a tab, refreshing the page, or zero viewers will NOT stop this instance.
    this.activeProcesses.set(projectId, {
      signalingProcess,
      ueProcess,
      playerPort,
      streamerPort,
      clients: 0,
      ownerId: userId,
    });

    // Create instance record in DB
    await this.prisma.instance.create({
      data: {
        projectId,
        port: playerPort,
        status: 'RUNNING',
        pid,
      },
    });

    // Update project status
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'RUNNING' },
    });

    return {
      message: 'Instance started successfully',
      port: playerPort,
      status: 'RUNNING',
      isSimulated: false,
    };
  }

  async stopInstance(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    const proc = this.activeProcesses.get(projectId);
    if (proc) {
      this.logger.log(`Stopping instance for project ${project.name}...`);
      if (proc.ueProcess && proc.ueProcess.pid) {
        this.logger.log(`Killing Unreal process PID ${proc.ueProcess.pid}`);
        try {
          this.killProcessTree(proc.ueProcess.pid);
        } catch (e) {
          this.logger.warn(`Could not kill process ${proc.ueProcess.pid}: ${e.message}`);
        }
      }
      if (proc.signalingProcess && proc.signalingProcess.pid) {
        this.logger.log(`Killing Signaling process PID ${proc.signalingProcess.pid}`);
        try {
          this.killProcessTree(proc.signalingProcess.pid);
        } catch (e) {
          this.logger.warn(`Could not kill process ${proc.signalingProcess.pid}: ${e.message}`);
        }
      }
      this.activeProcesses.delete(projectId);
    }

    // Update instance records in DB
    await this.prisma.instance.updateMany({
      where: { projectId, status: 'RUNNING' },
      data: { status: 'STOPPED' },
    });

    // Update project status
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'STOPPED' },
    });

    return {
      message: 'Instance stopped successfully',
      status: 'STOPPED',
    };
  }

  // Helper: Find first free TCP port in a range
  private async findFreePort(start: number, end: number): Promise<number> {
    const net = require('net');

    const checkPort = (port: number): Promise<boolean> => {
      return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
          server.close();
          resolve(true);
        });
        server.listen(port);
      });
    };

    for (let p = start; p <= end; p++) {
      if (await checkPort(p)) {
        return p;
      }
    }
    throw new Error('No free ports available in range');
  }

  // Helper: Find signaling server directory
  private getSignalingDir(): string {
    const paths = [
      path.resolve(process.cwd(), 'src', 'projects', 'signaling'),
      path.resolve(process.cwd(), 'apps', 'backend', 'src', 'projects', 'signaling'),
      path.resolve(__dirname, 'signaling'),
    ];
    for (const p of paths) {
      const jsPath = path.resolve(p, 'dist', 'index.js');
      if (fs.existsSync(jsPath)) {
        return p;
      }
    }
    throw new Error('Signaling server directory with compiled dist/index.js not found');
  }

  // Helper: Check if a port is bound and active
  private async checkPortStatus(port: number, timeoutMs = 10000): Promise<boolean> {
    const net = require('net');
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const isBound = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(500);
        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => {
          resolve(false);
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.connect(port, '127.0.0.1');
      });
      if (isBound) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  // Helper: Check if the signaling server's HTTP endpoint is responding
  private async checkHttpReady(port: number, timeoutMs = 10000): Promise<boolean> {
    const http = require('http');
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const isReady = await new Promise<boolean>((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/status`, { timeout: 2000 }, (res: any) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      });
      if (isReady) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  // Polls the signaling server's /status endpoint for the current player count (CCU).
  // This is purely informational — it never triggers auto-stop or process cleanup.
  // Instance lifecycle is entirely driven by explicit user actions (start/stop).
  private startMetricsPolling() {
    const axios = require('axios');
    setInterval(async () => {
      for (const [projectId, proc] of this.activeProcesses.entries()) {
        try {
          const res = await axios.get(`http://127.0.0.1:${proc.playerPort}/status`, {
            timeout: 1000,
          });
          if (res.data && typeof res.data.player_count === 'number') {
            proc.clients = res.data.player_count;
          }
        } catch (err) {
          // Ignore polling errors — does not affect instance lifecycle
        }
      }
    }, 3000);
  }

  // Binary exclusion list — filenames/substrings that are NEVER the project executable.
  // Covers Windows .exe utilities AND Linux binaries that ship alongside UE builds.
  private readonly BINARY_EXCLUSIONS = [
    'crashreport',
    'uninstall',
    'epicgames',
    'prereq',
    'install',
    'setup',
    'launcher',
    'messagelogger',
    'fileopenorder',
    'dotnet',
    'redist',
    'shaders',
    'tools',
  ];

  private isExcludedBinary(filename: string): boolean {
    const lower = filename.toLowerCase();
    return this.BINARY_EXCLUSIONS.some((excl) => lower.includes(excl));
  }

  private isLinux = process.platform === 'linux';

  // Check whether a file path is a candidate executable for the current platform.
  // Linux: file must have at least one execute permission bit set (X_OK) and must not
  //        be a shared library (.so), script, or other non-binary file.
  // Windows: file must end with .exe.
  private isCandidateExecutable(filePath: string, filename: string): boolean {
    if (this.isLinux) {
      // Reject known non-executable file types by extension
      const lower = filename.toLowerCase();
      if (
        lower.endsWith('.so') ||
        lower.endsWith('.so.') ||
        lower.endsWith('.sh') ||
        lower.endsWith('.py') ||
        lower.endsWith('.txt') ||
        lower.endsWith('.cfg') ||
        lower.endsWith('.ini') ||
        lower.endsWith('.log') ||
        lower.endsWith('.pak') ||
        lower.endsWith('.ucas') ||
        lower.endsWith('.utoc') ||
        lower.endsWith('.bin') ||
        lower.endsWith('.dat')
      ) {
        return false;
      }
      try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }
    // Windows: match .exe extension
    return filename.endsWith('.exe');
  }

  // Ensure the executable has the +x permission bit set (required on Linux).
  // Extracted ZIP/RAR archives often lose Unix permission bits.
  private ensureExecutable(filePath: string): void {
    if (!this.isLinux) return;
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
    } catch {
      this.logger.log(`Setting executable permission on: ${filePath}`);
      fs.chmodSync(filePath, 0o755);
    }
  }

  // Helper: Find the project executable. On Linux, detects by X_OK permission bit.
  // On Windows, detects by .exe extension. Prefers root-level candidates; never picks Engine/ binaries.
  private findExecutable(dir: string): string | null {
    this.logger.log(`Scanning for executable in: ${dir} (platform: ${process.platform})`);

    // PASS 1: Scan root directory only (non-recursive)
    const rootCandidates = this.scanDirForExecutables(dir);
    if (rootCandidates.length > 0) {
      this.logger.log(
        `Found ${rootCandidates.length} executable(s) at root level: ${rootCandidates.map((e) => path.basename(e)).join(', ')}`,
      );
      const selected = rootCandidates[0];
      this.ensureExecutable(selected);
      this.logger.log(`Selected root-level executable: ${selected}`);
      return selected;
    }

    this.logger.log(
      'No root-level executable found. Scanning subdirectories (excluding Engine/)...',
    );

    // PASS 2: Recurse into subdirectories but SKIP anything under Engine/
    const subCandidates = this.findExecutableRecursive(dir, dir);
    if (subCandidates.length > 0) {
      this.logger.log(
        `Found ${subCandidates.length} executable(s) in subdirectories: ${subCandidates.map((e) => path.relative(dir, e)).join(', ')}`,
      );
      const selected = subCandidates[0];
      this.ensureExecutable(selected);
      this.logger.log(`Selected subdirectory executable: ${selected}`);
      return selected;
    }

    this.logger.error(`No valid executable found anywhere in ${dir}`);
    return null;
  }

  // Scan a single directory (non-recursive) for candidate executables
  private scanDirForExecutables(dir: string): string[] {
    const results: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(dir, entry.name);
      if (!this.isCandidateExecutable(fullPath, entry.name)) continue;
      if (this.isExcludedBinary(entry.name)) {
        this.logger.debug(`Skipping excluded binary: ${entry.name}`);
        continue;
      }
      results.push(fullPath);
    }
    return results;
  }

  // Recurse into subdirectories looking for executables, skipping Engine/ directories entirely
  private findExecutableRecursive(root: string, dir: string): string[] {
    const results: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip Engine/ directory entirely — those binaries are UE editor/crash reporters, not the project
        if (entry.name === 'Engine') {
          this.logger.debug(`Skipping Engine/ directory: ${fullPath}`);
          continue;
        }
        const found = this.findExecutableRecursive(root, fullPath);
        results.push(...found);
      } else if (this.isCandidateExecutable(fullPath, entry.name)) {
        if (this.isExcludedBinary(entry.name)) {
          this.logger.debug(`Skipping excluded binary: ${fullPath}`);
          continue;
        }
        results.push(fullPath);
      }
    }
    return results;
  }

  // Helper: Clean up a stale instance whose processes are no longer alive
  private async cleanupStaleInstance(projectId: string, instanceId: string) {
    try {
      // Remove from in-memory process map if present
      const proc = this.activeProcesses.get(projectId);
      if (proc) {
        if (proc.ueProcess && proc.ueProcess.pid) {
          try {
            this.killProcessTree(proc.ueProcess.pid);
          } catch {
            /* ignore */
          }
        }
        if (proc.signalingProcess && proc.signalingProcess.pid) {
          try {
            this.killProcessTree(proc.signalingProcess.pid);
          } catch {
            /* ignore */
          }
        }
        this.activeProcesses.delete(projectId);
      }

      // Mark instance as stopped in DB
      await this.prisma.instance
        .update({
          where: { id: instanceId },
          data: { status: 'STOPPED' },
        })
        .catch(() => {});

      // Mark project as stopped
      await this.prisma.project
        .update({
          where: { id: projectId },
          data: { status: 'STOPPED' },
        })
        .catch(() => {});

      this.logger.log(`Cleaned up stale instance ${instanceId} for project ${projectId}`);
    } catch (err) {
      this.logger.error(`Failed to clean up stale instance ${instanceId}: ${err.message}`);
    }
  }

  // Helper: Kill a process and its entire child tree.
  // On Windows, taskkill /F /T handles recursive tree killing natively.
  // On Linux, we walk /proc/<pid>/task/<pid>/children to find descendants,
  // kill them bottom-up (children before parents), then kill the root.
  // This is critical because UE and Wilbur spawn their own child processes
  // (rendering workers, codec threads, signal handlers) that must also be stopped.
  private killProcessTree(pid: number): void {
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } catch {
        try {
          process.kill(pid);
        } catch {
          // process already dead
        }
      }
      return;
    }

    // Linux: recursively collect the full process tree from /proc
    const collectChildren = (ppid: number): number[] => {
      const children: number[] = [];
      try {
        const childrenFile = `/proc/${ppid}/task/${ppid}/children`;
        const content = fs.readFileSync(childrenFile, 'utf8').trim();
        if (content) {
          const childPids = content
            .split(/\s+/)
            .map(Number)
            .filter((n) => !isNaN(n));
          for (const childPid of childPids) {
            children.push(childPid);
            // Recurse into grandchildren
            children.push(...collectChildren(childPid));
          }
        }
      } catch {
        // /proc entry may not exist if process already exited
      }
      return children;
    };

    try {
      // Collect all descendants (bottom-up order doesn't matter since we have the full list)
      const childPids = collectChildren(pid);

      // Kill children first (deepest first to avoid orphaning)
      for (const childPid of childPids.reverse()) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // process already exited — ignore ESRCH
        }
      }

      // Kill the root process last
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // process already exited
      }
    } catch (err) {
      this.logger.warn(`Failed to kill process tree for PID ${pid}: ${err}`);
    }
  }
}
