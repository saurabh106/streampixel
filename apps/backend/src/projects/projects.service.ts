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
import AdmZip from 'adm-zip';
import { createExtractorFromFile } from 'node-unrar-js';

interface ActiveProcess {
  projectId: string;
  signalingProcess?: any;
  ueProcess?: any;
  playerPort: number;
  streamerPort: number;
  clients: number;
  ownerId: string;
  viewerId?: string;
}

@Injectable()
export class ProjectsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectsService.name);
  // Keyed by instanceId (not projectId). Each viewer gets their own dedicated
  // UE process + Wilbur signaling server, tracked independently.
  // Instance lifecycle is fully decoupled from WebSocket/browser connections.
  // Once started, an instance runs until explicitly stopped via stopInstance().
  // Player count is tracked for display only — zero players never triggers shutdown.
  private activeProcesses = new Map<string, ActiveProcess>();
  // Prevents concurrent spawn calls for the same project (e.g. React StrictMode
  // double-effect, rapid button clicks). Released once the spawn completes or fails.
  private spawningProjects = new Set<string>();
  private storagePath = process.env.STORAGE_PATH || 'G:\\store';

  constructor(private prisma: PrismaService) {}

  /** Get all running instances for a given project from the in-memory map. */
  private getInstancesForProject(projectId: string): Array<[string, ActiveProcess]> {
    return [...this.activeProcesses.entries()].filter(([, proc]) => proc.projectId === projectId);
  }

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
    for (const [, proc] of this.activeProcesses.entries()) {
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
    await this.prisma.project.create({
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
          if (fileCount <= 5 || entry.fileHeader.name.endsWith('.exe')) {
            this.logger.debug(`Extracted: ${entry.fileHeader.name}`);
          }
        }
        this.logger.log(`RAR extraction complete — ${fileCount} files extracted to ${projectDir}`);
      } else {
        this.logger.log(`Extracting project ZIP: ${zipPath}`);
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(projectDir, true);
        const entries = zip.getEntries();
        this.logger.log(
          `ZIP extraction complete — ${entries.length} entries extracted to ${projectDir}`,
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
          `⚠️ No valid executable (.exe) found in the extracted project archive. ` +
            `The project directory was scanned recursively (excluding Engine/ subfolders) ` +
            `but no project executable was detected. ` +
            `You will need to re-upload with a build that contains a .exe at the root level.`,
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
      const instances = this.getInstancesForProject(p.id);
      const totalClients = instances.reduce((sum, [, proc]) => sum + proc.clients, 0);
      return {
        ...p,
        clients: totalClients,
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

    const instances = this.getInstancesForProject(project.id);
    const totalClients = instances.reduce((sum, [, proc]) => sum + proc.clients, 0);
    return {
      ...project,
      clients: totalClients,
    };
  }

  // ─── Public viewer flow ──────────────────────────────────────────────

  async getByShareSlug(
    shareSlug: string,
    viewerId: string,
    viewportWidth: number,
    viewportHeight: number,
  ) {
    const project = await this.prisma.project.findUnique({
      where: { shareSlug },
      include: { instances: true },
    });

    if (!project) {
      throw new NotFoundException(`Project not found`);
    }

    // Check if this viewer already has a running instance (e.g. page refresh).
    // The unique constraint on (projectId, viewerId) ensures at most one per viewer.
    const existingViewerInstance = project.instances?.find(
      (i) => i.viewerId === viewerId && i.status === 'RUNNING',
    );

    if (existingViewerInstance) {
      // Verify the in-memory process is still tracked
      const proc = this.activeProcesses.get(existingViewerInstance.id);
      if (proc) {
        return {
          id: project.id,
          name: project.name,
          version: project.version,
          instanceId: existingViewerInstance.id,
          status: 'RUNNING',
          port: existingViewerInstance.port,
          isSimulated: false,
        };
      }
      // Process died but DB says RUNNING — fall through to create a fresh instance.
    }

    // Clean up any stale STOPPED/ERROR records for this viewer before creating new
    const staleInstance = project.instances?.find(
      (i) => i.viewerId === viewerId && i.status !== 'RUNNING',
    );
    if (staleInstance) {
      await this.prisma.instance.delete({ where: { id: staleInstance.id } }).catch(() => {});
    }

    // No running instance for this viewer — auto-start one with their viewport.
    const startResult = await this.spawnInstance({
      project,
      ownerId: project.userId,
      viewerId,
      viewportWidth,
      viewportHeight,
    });

    return {
      id: project.id,
      name: project.name,
      version: project.version,
      instanceId: startResult.instanceId,
      status: 'RUNNING',
      port: startResult.port,
      isSimulated: false,
    };
  }

  /** Look up a project by its share slug (used by public stop endpoint). */
  async findProjectByShareSlug(shareSlug: string) {
    const project = await this.prisma.project.findUnique({ where: { shareSlug } });
    if (!project) {
      throw new NotFoundException(`Project not found`);
    }
    return project;
  }

  // ─── Owner dashboard flow ────────────────────────────────────────────

  async startInstance(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    // Check if owner already has a running instance
    const existingOwnerInstance = await this.prisma.instance.findFirst({
      where: { projectId, viewerId: null, status: 'RUNNING' },
    });

    if (existingOwnerInstance) {
      const proc = this.activeProcesses.get(existingOwnerInstance.id);
      if (proc) {
        return {
          message: 'Instance is already running',
          port: proc.playerPort,
          status: existingOwnerInstance.status,
          isSimulated: false,
        };
      }
      // Stale record, clean up
      await this.prisma.instance
        .update({ where: { id: existingOwnerInstance.id }, data: { status: 'STOPPED' } })
        .catch(() => {});
    }

    // Spawn instance with default 1920x1080 (owner preview)
    return this.spawnInstance({
      project,
      ownerId: userId,
    });
  }

  async stopInstance(projectId: string, userId: string, instanceId?: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    if (instanceId) {
      // Stop a specific instance (owner targeting one)
      await this.stopSingleInstance(instanceId);
    } else {
      // Stop ALL instances for this project
      const instances = this.getInstancesForProject(projectId);
      for (const [id] of instances) {
        await this.stopSingleInstance(id);
      }
    }

    // Check if any instances remain running
    const remainingInstances = this.getInstancesForProject(projectId);
    const anyRunning = remainingInstances.length > 0;

    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: anyRunning ? 'RUNNING' : 'STOPPED' },
    });

    return {
      message: 'Instance stopped successfully',
      status: 'STOPPED',
    };
  }

  // ─── Public viewer stop ──────────────────────────────────────────────

  async stopViewerInstance(projectId: string, viewerId: string) {
    const instances = this.getInstancesForProject(projectId);
    const viewerEntry = instances.find(([, proc]) => proc.viewerId === viewerId);

    if (viewerEntry) {
      const [instanceId] = viewerEntry;
      await this.stopSingleInstance(instanceId);
    } else {
      // No in-memory process; also clean DB
      await this.prisma.instance
        .updateMany({
          where: { projectId, viewerId, status: 'RUNNING' },
          data: { status: 'STOPPED' },
        })
        .catch(() => {});
    }

    // Check if any instances remain
    const remainingInstances = this.getInstancesForProject(projectId);
    if (remainingInstances.length === 0) {
      await this.prisma.project
        .update({ where: { id: projectId }, data: { status: 'STOPPED' } })
        .catch(() => {});
    }

    return { message: 'Viewer instance stopped successfully', status: 'STOPPED' };
  }

  async delete(id: string, userId: string) {
    const project = await this.findOne(id, userId);

    // Stop all instances if any are running
    const instances = this.getInstancesForProject(id);
    if (instances.length > 0 || project.status === 'RUNNING') {
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

  // ─── Instance spawning (shared by owner + viewer flows) ──────────────

  private async spawnInstance(params: {
    project: any;
    ownerId: string;
    viewerId?: string;
    viewportWidth?: number;
    viewportHeight?: number;
  }) {
    const { project, ownerId, viewerId, viewportWidth, viewportHeight } = params;

    // Prevent concurrent spawns for the same project — if another call is already
    // in progress (React StrictMode double-effect, rapid button clicks, etc.),
    // wait for it to finish and return its result instead of spawning a duplicate.
    if (this.spawningProjects.has(project.id)) {
      this.logger.warn(
        `Project ${project.id} is already spawning — waiting for existing spawn to complete`,
      );
      // Poll until the spawning finishes (max 30s)
      const deadline = Date.now() + 30000;
      while (this.spawningProjects.has(project.id) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      // Return the existing running instance if one was created
      const existingInstance = [...this.activeProcesses.values()].find(
        (p) => p.projectId === project.id && (!viewerId || p.viewerId === viewerId),
      );
      if (existingInstance) {
        return {
          instanceId: '', // will be set by caller from DB
          port: existingInstance.playerPort,
          status: 'RUNNING',
          isSimulated: false,
        };
      }
      // If still marked as spawning after timeout, something went wrong — proceed anyway
    }

    this.spawningProjects.add(project.id);

    // Set project status to STARTING so concurrent requests see the project is in-flight
    await this.prisma.project
      .update({ where: { id: project.id }, data: { status: 'STARTING' } })
      .catch(() => {});

    // CCU enforcement: count running instances for this project
    const runningInstances = this.getInstancesForProject(project.id);
    if (runningInstances.length >= (project.maxCCU || 3)) {
      this.spawningProjects.delete(project.id);
      throw new BadRequestException(
        `Project has reached its maximum concurrent viewer limit (${project.maxCCU || 3}). ` +
          `Please try again later.`,
      );
    }

    // Allocate free ports starting from 8800
    const streamerPort = await this.findFreePort(8800, 8900);
    const playerPort = await this.findFreePort(streamerPort + 1, 9000);
    const sfuPort = await this.findFreePort(playerPort + 1, 9100);
    const viewerLabel = viewerId ? ` (viewer: ${viewerId})` : ' (owner preview)';
    this.logger.log(
      `Allocated streamerPort ${streamerPort}, playerPort ${playerPort}, sfuPort ${sfuPort} for project ${project.name}${viewerLabel}`,
    );

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

    // Per-viewer signaling server — max_players = 1 since each viewer has their own
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
      '1',
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

    if (!project.executablePath || !project.extractedPath) {
      this.logger.error(
        `Project "${project.name}" has no executablePath recorded. ` +
          `The upload scan did not find a valid .exe in the archive. ` +
          `Ensure your packaged build folder contains the project .exe at its root level.`,
      );
      if (signalingProcess && signalingProcess.pid) {
        this.killProcessTree(signalingProcess.pid);
      }
      this.spawningProjects.delete(project.id);
      throw new BadRequestException(
        `No Unreal Engine executable found in project "${project.name}". ` +
          `Ensure your packaged build contains a .exe at the root level of the archive (not inside Engine/). ` +
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
      this.spawningProjects.delete(project.id);
      throw new BadRequestException(
        `Executable file not found at expected path: ${project.executablePath}. ` +
          `The file may have been moved or deleted after upload.`,
      );
    }

    this.logger.log(`Spawning Unreal Engine executable: ${absoluteExePath}`);
    this.logger.log(`UE launch dir: ${path.dirname(absoluteExePath)}`);

    // Diagnostic: check that the PixelStreaming plugin exists in the packaged build.
    // If it's missing, UE will launch fine but never connect to Wilbur — the stream
    // will hang indefinitely on "Exchanging SDP configuration tokens".
    try {
      this.checkPixelStreamingPlugin(project.extractedPath, project.name);
    } catch (pluginErr: any) {
      if (signalingProcess && signalingProcess.pid) {
        this.killProcessTree(signalingProcess.pid);
      }
      this.spawningProjects.delete(project.id);
      throw pluginErr;
    }

    // Add Windows Firewall rules before spawning so the exe can bind/listen
    // without triggering a manual "Allow access" prompt (which hangs headless processes).
    await this.addFirewallRule(project.id, absoluteExePath);

    // Use viewer's exact viewport or default to 1920x1080 for owner preview
    const resX = viewportWidth || 1920;
    const resY = viewportHeight || 1080;

    // PixelStreaming2 launch flags (UE 5.4+)
    // -PixelStreamingSignallingURL is the single-flag connection string for PixelStreaming2.
    // Do NOT pass -PixelStreamingIP/-PixelStreamingPort alongside it — those are legacy
    // (PixelStreaming1) flags and passing both simultaneously causes the plugin to silently
    // fail to register as a streamer with Wilbur.
    const args = [
      '-RenderOffscreen',
      '-AudioMixer',
      `-PixelStreamingSignallingURL=ws://127.0.0.1:${streamerPort}`,
      '-PixelStreamingEncoderCodec=H264',
      '-PixelStreamingWebRTCFps=60',
      '-PixelStreamingEncoderMinQP=1',
      '-PixelStreamingEncoderMaxQP=28',
      '-PixelStreamingEncoderTargetBitrate=20000',
      '-PixelStreamingEncoderMaxBitrate=50000',
      '-PixelStreamingEncoderRateControl=CBR',
      '-ForceRes',
      `-ResX=${resX}`,
      `-ResY=${resY}`,
      '-Windowed',
    ];
    this.logger.log(`UE launch args: ${args.join(' ')}`);

    let ueProcess: any;
    let pid: number;

    try {
      ueProcess = spawn(absoluteExePath, args, {
        cwd: path.dirname(absoluteExePath),
      });

      // Capture UE process stdout/stderr for debugging.
      // PixelStreaming-related lines are promoted to log level for visibility,
      // since they're critical for diagnosing streamer registration with Wilbur.
      ueProcess.stdout?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (!msg) return;
        if (/pixelstreaming|signall?er|webrtc|streamer|registered/i.test(msg)) {
          this.logger.log(`[UE-PID ${ueProcess.pid}][PS]: ${msg}`);
        } else {
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
      await this.removeFirewallRule(project.id);
      this.spawningProjects.delete(project.id);
      throw new BadRequestException(
        `Failed to launch Unreal Engine executable: ${err.message}. ` +
          `Ensure the .exe is a valid Windows binary and not corrupted.`,
      );
    }

    // Create instance record in DB (with viewer metadata for per-viewer instances)
    const instance = await this.prisma.instance.create({
      data: {
        projectId: project.id,
        port: playerPort,
        status: 'RUNNING',
        pid,
        viewerId: viewerId || null,
        viewportWidth: viewportWidth || null,
        viewportHeight: viewportHeight || null,
      },
    });

    // Save processes in memory map, keyed by instanceId (not projectId)
    // Instance lifecycle is decoupled from any browser/WebSocket connection:
    // closing a tab, refreshing the page, or zero viewers will NOT stop this instance.
    // Only explicit stopViewerInstance() or stopInstance() will tear it down.
    this.activeProcesses.set(instance.id, {
      projectId: project.id,
      signalingProcess,
      ueProcess,
      playerPort,
      streamerPort,
      clients: 0,
      ownerId,
      viewerId,
    });

    // Update project status
    await this.prisma.project.update({
      where: { id: project.id },
      data: { status: 'RUNNING' },
    });

    this.logger.log(
      `Instance ${instance.id} started successfully${viewerLabel} on port ${playerPort} ` +
        `(${resX}x${resY})`,
    );

    this.spawningProjects.delete(project.id);

    return {
      instanceId: instance.id,
      port: playerPort,
      status: 'RUNNING',
      isSimulated: false,
    };
  }

  // ─── Instance teardown ───────────────────────────────────────────────

  /** Stop a single instance by its ID (kills processes, cleans up map + DB). */
  private async stopSingleInstance(instanceId: string) {
    const proc = this.activeProcesses.get(instanceId);
    if (proc) {
      this.logger.log(`Stopping instance ${instanceId}...`);
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
      // Remove the Windows Firewall rule that was added for this instance
      await this.removeFirewallRule(proc.projectId);
      this.activeProcesses.delete(instanceId);
    }

    // Update instance record in DB
    await this.prisma.instance
      .update({ where: { id: instanceId }, data: { status: 'STOPPED' } })
      .catch(() => {});
  }

  // ─── Diagnostics ────────────────────────────────────────────────────

  /**
   * Checks whether the PixelStreaming plugin is present in the packaged UE build.
   * If missing, UE will launch and render fine but never connect to Wilbur,
   * causing the stream to hang forever on "Exchanging SDP configuration tokens".
   *
   * This is a known issue with packaged UE builds: the PixelStreaming plugin must
   * be explicitly enabled in the .uproject file BEFORE packaging. If you packaged
   * the build without it, you must re-package with the plugin enabled.
   */
  private checkPixelStreamingPlugin(extractedPath: string | null, projectName: string) {
    if (!extractedPath) return;

    const buildDir = path.resolve(extractedPath);

    // Recursively search for PixelStreaming .uplugin files in the build directory
    const findPlugin = (dir: string, depth = 0): string | null => {
      if (depth > 6) return null; // don't recurse too deep
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return null;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && /^PixelStreaming.*\.uplugin$/i.test(entry.name)) {
          return fullPath;
        }
        if (
          entry.isDirectory() &&
          entry.name !== 'Engine' && // don't recurse into nested Engine dirs
          !entry.name.startsWith('.')
        ) {
          const found = findPlugin(fullPath, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };

    const pluginPath = findPlugin(buildDir);
    if (pluginPath) {
      this.logger.log(`PixelStreaming plugin found: ${pluginPath}`);
    } else {
      const helpMsg =
        `PixelStreaming plugin not found in packaged build for "${projectName}". ` +
        `The UE process would launch but never connect to the signaling server, ` +
        `causing the browser stream to hang on "Connecting...". ` +
        `Re-package your UE build with the PixelStreaming plugin enabled ` +
        `(check "Pixel Streaming" in Edit → Plugins, or add ` +
        `{ "Name": "PixelStreaming", "Enabled": true } to your .uproject), ` +
        `then re-upload.`;

      this.logger.error(
        `\n` +
          `══════════════════════════════════════════════════════════════════\n` +
          `  PIXEL STREAMING PLUGIN NOT FOUND IN PACKAGED BUILD\n` +
          `══════════════════════════════════════════════════════════════════\n` +
          `  Project: ${projectName}\n` +
          `  Build:   ${buildDir}\n` +
          `\n` +
          `  The UE process will launch and render, but will NEVER connect\n` +
          `  to Wilbur (the signaling server). The browser stream will hang\n` +
          `  forever on "Exchanging SDP configuration tokens".\n` +
          `\n` +
          `  TO FIX: Re-package your UE build with the PixelStreaming plugin\n` +
          `  enabled. In your .uproject file, ensure:\n` +
          `\n` +
          `    "Plugins": [\n` +
          `      { "Name": "PixelStreaming", "Enabled": true }\n` +
          `    ]\n` +
          `\n` +
          `  Then re-package the build and re-upload.\n` +
          `══════════════════════════════════════════════════════════════════`,
      );

      throw new BadRequestException(helpMsg);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  // Helper: Add Windows Firewall rules for the UE executable so it can
  // bind/listen/connect without triggering a manual "Allow access" prompt.
  // Requires the backend process to run as Administrator.
  // Logs a clear ERROR on failure but does NOT throw — the UE process will
  // still launch, though Windows may prompt for firewall access or block it.
  private async addFirewallRule(projectId: string, exePath: string): Promise<void> {
    if (process.platform !== 'win32') return;
    const ruleName = `PixelStreaming-${projectId}`;
    const { execSync } = require('child_process');
    try {
      execSync(
        `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow program="${exePath}" enable=yes`,
        { timeout: 10000 },
      );
      execSync(
        `netsh advfirewall firewall add rule name="${ruleName}-out" dir=out action=allow program="${exePath}" enable=yes`,
        { timeout: 10000 },
      );
      this.logger.log(`Added Windows Firewall rules for ${exePath} (rule: ${ruleName})`);
    } catch (err: any) {
      const output = (err.stdout?.toString() || '') + (err.stderr?.toString() || '');
      this.logger.error(
        `═══════════════════════════════════════════════════════════════\n` +
          `  FIREWALL RULE FAILED — UE process may be blocked by Windows\n` +
          `═══════════════════════════════════════════════════════════════\n` +
          `  Rule:    ${ruleName}\n` +
          `  EXE:     ${exePath}\n` +
          `  Error:   ${err.message}\n` +
          `  Output:  ${output.trim() || '(empty)'}\n` +
          `\n` +
          `  TO FIX: Open an elevated (Administrator) PowerShell and run:\n` +
          `    netsh advfirewall firewall add rule name="${ruleName}" dir=in  action=allow program="${exePath}" enable=yes\n` +
          `    netsh advfirewall firewall add rule name="${ruleName}-out" dir=out action=allow program="${exePath}" enable=yes\n` +
          `\n` +
          `  Or re-launch the backend as Administrator:\n` +
          `    Right-click PowerShell → "Run as Administrator"\n` +
          `    cd S:\\mvp\\apps\\backend && npm run dev\n` +
          `═══════════════════════════════════════════════════════════════`,
      );
      this.logger.warn(
        `Proceeding without firewall rule — UE process will start but may not be reachable.`,
      );
    }
  }

  // Helper: Remove Windows Firewall rules for a project
  private async removeFirewallRule(projectId: string): Promise<void> {
    if (process.platform !== 'win32') return;
    const ruleName = `PixelStreaming-${projectId}`;
    try {
      const { execSync } = require('child_process');
      execSync(`netsh advfirewall firewall delete rule name="${ruleName}"`, {
        stdio: 'ignore',
        timeout: 10000,
      });
      execSync(`netsh advfirewall firewall delete rule name="${ruleName}-out"`, {
        stdio: 'ignore',
        timeout: 10000,
      });
      this.logger.log(`Removed Windows Firewall rules (rule: ${ruleName})`);
    } catch (err: any) {
      this.logger.warn(`Failed to remove Windows Firewall rule: ${err.message}`);
    }
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
      for (const [, proc] of this.activeProcesses.entries()) {
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

  // Helper: Exe exclusion list — names that are NEVER the project executable
  private readonly EXE_EXCLUSIONS = [
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
  ];

  private isExcludedExe(filename: string): boolean {
    const lower = filename.toLowerCase();
    return this.EXE_EXCLUSIONS.some((excl) => lower.includes(excl));
  }

  // Helper: Find the project executable. Prefers root-level .exe, never picks Engine/ exes.
  private findExecutable(dir: string): string | null {
    this.logger.log(`Scanning for executable in: ${dir}`);

    // PASS 1: Scan root directory only (non-recursive)
    const rootExes = this.scanDirForExes(dir);
    if (rootExes.length > 0) {
      this.logger.log(
        `Found ${rootExes.length} executable(s) at root level: ${rootExes.map((e) => path.basename(e)).join(', ')}`,
      );
      const selected = rootExes[0];
      this.logger.log(`Selected root-level executable: ${selected}`);
      return selected;
    }

    this.logger.log(
      'No root-level executable found. Scanning subdirectories (excluding Engine/)...',
    );

    // PASS 2: Recurse into subdirectories but SKIP anything under Engine/
    const subExes = this.findExecutableRecursive(dir, dir);
    if (subExes.length > 0) {
      this.logger.log(
        `Found ${subExes.length} executable(s) in subdirectories: ${subExes.map((e) => path.relative(dir, e)).join(', ')}`,
      );
      const selected = subExes[0];
      this.logger.log(`Selected subdirectory executable: ${selected}`);
      return selected;
    }

    this.logger.error(`No valid executable found anywhere in ${dir}`);
    return null;
  }

  // Scan a single directory (non-recursive) for .exe files
  private scanDirForExes(dir: string): string[] {
    const results: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.exe')) continue;
      if (this.isExcludedExe(entry.name)) {
        this.logger.debug(`Skipping excluded exe: ${entry.name}`);
        continue;
      }
      results.push(path.join(dir, entry.name));
    }
    return results;
  }

  // Recurse into subdirectories looking for exes, skipping Engine/ directories entirely
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
        // Skip Engine/ directory entirely — those exes are UE editor/crash reporters, not the project
        if (entry.name === 'Engine') {
          this.logger.debug(`Skipping Engine/ directory: ${fullPath}`);
          continue;
        }
        const found = this.findExecutableRecursive(root, fullPath);
        results.push(...found);
      } else if (entry.name.endsWith('.exe')) {
        if (this.isExcludedExe(entry.name)) {
          this.logger.debug(`Skipping excluded exe: ${fullPath}`);
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
      // Remove from in-memory process map if present (keyed by instanceId)
      const proc = this.activeProcesses.get(instanceId);
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
        this.activeProcesses.delete(instanceId);
      }

      // Mark instance as stopped in DB
      await this.prisma.instance
        .update({
          where: { id: instanceId },
          data: { status: 'STOPPED' },
        })
        .catch(() => {});

      // Mark project as stopped only if no other instances are running
      const remaining = this.getInstancesForProject(projectId);
      if (remaining.length === 0) {
        await this.prisma.project
          .update({
            where: { id: projectId },
            data: { status: 'STOPPED' },
          })
          .catch(() => {});
      }

      this.logger.log(`Cleaned up stale instance ${instanceId} for project ${projectId}`);
    } catch (err) {
      this.logger.error(`Failed to clean up stale instance ${instanceId}: ${err.message}`);
    }
  }

  // Helper: Kill a process and its children (cross-platform)
  private killProcessTree(pid: number): void {
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } catch {
        try {
          process.kill(pid);
        } catch {
          // ignore
        }
      }
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }
}
