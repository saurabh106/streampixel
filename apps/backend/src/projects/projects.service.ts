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

interface UploadSession {
  sessionId: string;
  projectName: string;
  fileName: string;
  userId: string;
  totalChunks: number;
  totalSize: number;
  uploadedChunks: Set<number>;
  chunksDir: string;
  createdAt: number;
}

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
      xvfbProcess?: any;
      playerPort: number;
      streamerPort: number;
      clients: number;
      ownerId: string;
      lastError?: string;
      autoRestart: boolean;
      restartTimer?: any;
    }
  >();
  // Storage root: configurable via STORAGE_PATH env var.
  // Defaults to /opt/streampixel/storage on Linux, ./storage on other platforms.
  private storagePath =
    process.env.STORAGE_PATH ||
    (process.platform === 'linux'
      ? '/opt/streampixel/storage'
      : path.resolve(process.cwd(), 'storage'));

  // In-memory upload sessions for chunked upload with resume support.
  // Sessions auto-expire after 24 hours. Backend restarts also clear them.
  private uploadSessions = new Map<string, UploadSession>();

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
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
    try {
      const instances = await this.prisma.instance.findMany({ where: { status: 'RUNNING' } });
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
    } catch (err: any) {
      this.logger.error(`Failed to check instance states on startup: ${err.message}`);
    }

    this.startMetricsPolling();
  }

  async onModuleDestroy() {
    this.logger.log('Shutting down. Cleaning up all active processes...');
    for (const [projectId, proc] of this.activeProcesses.entries()) {
      // Cancel any pending auto-restart timers
      if (proc.restartTimer) {
        clearTimeout(proc.restartTimer);
      }
      if (proc.xvfbProcess && proc.xvfbProcess.pid) {
        this.logger.log(`Killing Xvfb process PID ${proc.xvfbProcess.pid}`);
        this.killProcessTree(proc.xvfbProcess.pid);
      }
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

  async create(file: Express.Multer.File, name: string, userId: string) {
    if (!file) {
      throw new BadRequestException('Unreal Engine project ZIP file is required');
    }

    const projectId =
      path.parse(file.originalname).name.replace(/[^a-zA-Z0-9_-]/g, '') + '-' + Date.now();
    const projectDir = path.join(this.storagePath, 'projects', projectId);

    // Create project directory
    fs.mkdirSync(projectDir, { recursive: true });

    const zipPath = path.join(projectDir, file.originalname);
    if (file.path && fs.existsSync(file.path)) {
      fs.renameSync(file.path, zipPath);
    } else if (file.buffer) {
      fs.writeFileSync(zipPath, file.buffer);
    } else {
      throw new BadRequestException('No uploaded file path or buffer found');
    }

    // Save temporary record to DB (version will be auto-detected after extraction)
    const shareSlug = Math.random().toString(36).substring(2, 10);
    const project = await this.prisma.project.create({
      data: {
        id: projectId,
        name,
        version: 'Detecting...',
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
        this.logger.log(`ZIP extraction complete — ${entryCount} files extracted to ${projectDir}`);
      }

      // Remove Windows Zone.Identifier (Mark-of-the-Web) from all extracted files.
      // When files are saved from an HTTP upload or extracted from a downloaded archive,
      // Windows attaches a Zone.Identifier ADS that triggers SmartScreen / "Open File" popups.
      // This strips that marker so executables can launch without user prompts.
      this.removeZoneIdentifier(projectDir);

      // Fix permissions on extracted files. ZIP/RAR archives often lose Unix permission bits,
      // so .sh launcher scripts and ELF binaries won't be executable after extraction.
      this.fixExtractedPermissions(projectDir);

      // Auto-detect UE version from Engine/Build/Build.version
      // At upload time we don't know the build root yet, so scan the extracted directory
      const detectedVersion = this.detectUEVersion(projectDir);
      this.logger.log(`Auto-detected engine version: ${detectedVersion}`);
      await this.prisma.project.update({
        where: { id: projectId },
        data: { version: detectedVersion },
      });

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
      this.logger.error(`[Upload:Extract] Failed to extract/scan archive for ${projectId}: ${error.message}`);
      // Clean up failed extraction directory
      try {
        if (fs.existsSync(projectDir)) {
          fs.rmSync(projectDir, { recursive: true, force: true });
          this.logger.log(`[Upload:Extract] Cleaned up failed extraction directory: ${projectDir}`);
        }
      } catch (cleanupErr) {
        this.logger.error(`[Upload:Extract] Failed to clean up extraction dir: ${cleanupErr.message}`);
      }
      throw new BadRequestException(
        `Failed to extract project archive: ${error.message}. Please ensure the file is a valid ZIP or RAR archive.`,
      );
    }

    return this.prisma.project.findUnique({
      where: { id: projectId },
    });
  }

  // ──────────────────────────────────────────────────────────────
  //  Chunked upload with resume support
  // ──────────────────────────────────────────────────────────────

  async initUpload(
    name: string,
    fileName: string,
    totalChunks: number,
    totalSize: number,
    userId: string,
  ) {
    if (!name) throw new BadRequestException('Project name is required');
    if (!fileName) throw new BadRequestException('File name is required');
    if (!totalChunks || totalChunks < 1) throw new BadRequestException('Invalid chunk count');

    const sessionId = `chunk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const chunksDir = path.join(this.storagePath, 'tmp', 'chunks', sessionId);
    fs.mkdirSync(chunksDir, { recursive: true });

    const session: UploadSession = {
      sessionId,
      projectName: name,
      fileName,
      userId,
      totalChunks,
      totalSize,
      uploadedChunks: new Set<number>(),
      chunksDir,
      createdAt: Date.now(),
    };
    this.uploadSessions.set(sessionId, session);
    this.logger.log(
      `Upload session initialized: ${sessionId} — ${fileName} (${(totalSize / 1024 / 1024).toFixed(1)}MB, ${totalChunks} chunks)`,
    );

    // Auto-cleanup after 24 hours
    setTimeout(() => {
      if (this.uploadSessions.has(sessionId)) {
        this.uploadSessions.delete(sessionId);
        try {
          fs.rmSync(chunksDir, { recursive: true, force: true });
        } catch {}
        this.logger.log(`Upload session ${sessionId} expired and cleaned up`);
      }
    }, 24 * 60 * 60 * 1000);

    return { sessionId, totalChunks, totalSize };
  }

  async uploadChunk(
    sessionId: string,
    chunkIndex: number,
    chunkBuffer: Buffer,
    userId: string,
  ) {
    const session = this.uploadSessions.get(sessionId);
    if (!session) {
      this.logger.warn(`[ChunkedUpload] Session not found or expired: ${sessionId}`);
      throw new BadRequestException('Upload session not found or expired. Please start a new upload.');
    }
    if (session.userId !== userId) {
      this.logger.warn(`[ChunkedUpload] Unauthorized chunk upload: session=${sessionId} user=${userId} owner=${session.userId}`);
      throw new BadRequestException('Unauthorized');
    }

    if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      this.logger.warn(`[ChunkedUpload] Invalid chunk index ${chunkIndex} (total: ${session.totalChunks}) session=${sessionId}`);
      throw new BadRequestException(`Invalid chunk index ${chunkIndex} (total: ${session.totalChunks})`);
    }

    const chunkPath = path.join(session.chunksDir, `chunk_${chunkIndex}`);
    fs.writeFileSync(chunkPath, chunkBuffer);
    session.uploadedChunks.add(chunkIndex);

    this.logger.log(
      `[ChunkedUpload] Chunk ${chunkIndex + 1}/${session.totalChunks} saved (${chunkBuffer.length} bytes) session=${sessionId} progress=${((session.uploadedChunks.size / session.totalChunks) * 100).toFixed(1)}%`,
    );

    return {
      received: session.uploadedChunks.size,
      total: session.totalChunks,
      sessionId,
      complete: session.uploadedChunks.size === session.totalChunks,
    };
  }

  async completeUpload(sessionId: string, userId: string) {
    const session = this.uploadSessions.get(sessionId);
    if (!session) {
      this.logger.warn(`[ChunkedUpload:Complete] Session not found or expired: ${sessionId}`);
      throw new BadRequestException('Upload session not found or expired. Please start a new upload.');
    }
    if (session.userId !== userId) {
      this.logger.warn(`[ChunkedUpload:Complete] Unauthorized: session=${sessionId} user=${userId} owner=${session.userId}`);
      throw new BadRequestException('Unauthorized');
    }

    if (session.uploadedChunks.size !== session.totalChunks) {
      const missing = [];
      for (let i = 0; i < session.totalChunks; i++) {
        if (!session.uploadedChunks.has(i)) missing.push(i);
      }
      this.logger.error(`[ChunkedUpload:Complete] Incomplete upload: ${session.uploadedChunks.size}/${session.totalChunks} chunks. Missing: [${missing.join(', ')}]`);
      throw new BadRequestException(
        `Upload incomplete: ${session.uploadedChunks.size}/${session.totalChunks} chunks received. Missing chunks: ${missing.join(', ')}`,
      );
    }

    this.logger.log(`[ChunkedUpload:Complete] Assembling ${session.totalChunks} chunks (${(session.totalSize / 1024 / 1024).toFixed(1)}MB) for session ${sessionId}...`);

    // Assemble chunks into the final file
    const assembledPath = path.join(session.chunksDir, session.fileName);
    const writeStream = fs.createWriteStream(assembledPath);

    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(session.chunksDir, `chunk_${i}`);
      const data = fs.readFileSync(chunkPath);
      writeStream.write(data);
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      writeStream.end();
    });

    this.logger.log(
      `[ChunkedUpload:Complete] Assembly complete: ${assembledPath} (${(session.totalSize / 1024 / 1024).toFixed(1)}MB)`,
    );

    // Clean up individual chunk files
    let cleanedChunks = 0;
    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(session.chunksDir, `chunk_${i}`);
      try {
        fs.unlinkSync(chunkPath);
        cleanedChunks++;
      } catch {}
    }
    this.logger.log(`[ChunkedUpload:Complete] Cleaned up ${cleanedChunks}/${session.totalChunks} chunk files`);

    // Build a fake Multer file object to pass to the existing create() method
    const fakeFile = {
      fieldname: 'file',
      originalname: session.fileName,
      encoding: '7bit',
      mimetype: 'application/octet-stream',
      size: session.totalSize,
      destination: session.chunksDir,
      filename: session.fileName,
      path: assembledPath,
      buffer: undefined,
      stream: undefined,
    } as unknown as Express.Multer.File;

    // Clean up session
    this.uploadSessions.delete(sessionId);

    // Delegate to the existing create() method which handles extraction, permissions, etc.
    return this.create(fakeFile, session.projectName, session.userId);
  }

  getUploadStatus(sessionId: string, userId: string) {
    const session = this.uploadSessions.get(sessionId);
    if (!session) {
      this.logger.debug(`[ChunkedUpload:Status] Session not found: ${sessionId}`);
      return { exists: false };
    }
    if (session.userId !== userId) {
      this.logger.warn(`[ChunkedUpload:Status] Unauthorized: session=${sessionId} user=${userId}`);
      throw new BadRequestException('Unauthorized');
    }
    this.logger.log(`[ChunkedUpload:Status] session=${sessionId} received=${session.uploadedChunks.size}/${session.totalChunks} (${((session.uploadedChunks.size / session.totalChunks) * 100).toFixed(1)}%)`);
    return {
      exists: true,
      sessionId: session.sessionId,
      fileName: session.fileName,
      projectName: session.projectName,
      totalChunks: session.totalChunks,
      totalSize: session.totalSize,
      uploadedChunks: Array.from(session.uploadedChunks).sort((a, b) => a - b),
      received: session.uploadedChunks.size,
    };
  }

  private async generateUniqueShareSlug(): Promise<string> {
    let slug = '';
    let exists = true;
    let attempts = 0;
    while (exists && attempts < 10) {
      slug = Math.random().toString(36).substring(2, 10);
      const found = await this.prisma.project.findUnique({ where: { shareSlug: slug } });
      if (!found) exists = false;
      attempts++;
    }
    return slug;
  }

  async generateShareSlug(id: string, userId: string) {
    const project = await this.findOne(id, userId);
    if (project.shareSlug) {
      return project;
    }
    const shareSlug = await this.generateUniqueShareSlug();
    const updated = await this.prisma.project.update({
      where: { id },
      data: { shareSlug },
      include: { instances: true },
    });
    const proc = this.activeProcesses.get(id);
    return {
      ...updated,
      clients: proc ? proc.clients : 0,
    };
  }

  async findAll(userId: string) {
    const projects = await this.prisma.project.findMany({
      where: { userId },
      include: { instances: true },
      orderBy: { createdAt: 'desc' },
    });

    return Promise.all(
      projects.map(async (p: any) => {
        let shareSlug = p.shareSlug;
        if (!shareSlug) {
          shareSlug = await this.generateUniqueShareSlug();
          await this.prisma.project.update({
            where: { id: p.id },
            data: { shareSlug },
          });
        }
        const proc = this.activeProcesses.get(p.id);
        return {
          ...p,
          shareSlug,
          clients: proc ? proc.clients : 0,
        };
      }),
    );
  }

  async findOne(id: string, userId: string) {
    let project = await this.prisma.project.findFirst({
      where: { id, userId },
      include: { instances: true },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    if (!project.shareSlug) {
      const shareSlug = await this.generateUniqueShareSlug();
      project = await this.prisma.project.update({
        where: { id },
        data: { shareSlug },
        include: { instances: true },
      });
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
    const activeInstance = project.instances?.find((i: any) => i.status === 'RUNNING');
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
    const peerOptions = JSON.stringify({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
    });

    const signalingArgs = [
      jsPath,
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
      '--peer_options',
      peerOptions,
    ];

    let signalingProcess: any;
    let signalingStderr = '';

    try {
      signalingProcess = spawn('node', signalingArgs, {
        cwd: signalingDir,
      });

      // Capture logs to NestJS Logger & buffer stderr for diagnostics
      signalingProcess.stdout?.on('data', (data: any) => {
        this.logger.debug(`[Signaling-PID ${signalingProcess.pid}]: ${data.toString().trim()}`);
      });
      signalingProcess.stderr?.on('data', (data: any) => {
        const msg = data.toString().trim();
        signalingStderr += msg + '\n';
        this.logger.error(`[Signaling-PID ${signalingProcess.pid}]: ${msg}`);
      });

      this.logger.log(`Signaling server process spawned with PID ${signalingProcess.pid}`);
    } catch (err) {
      this.logger.error(`Failed to spawn signaling server: ${err.message}`);
      throw new BadRequestException(`Failed to spawn signaling server: ${err.message}`);
    }

    // Wait for the signaling server player port to become active
    this.logger.log(`Waiting for signaling server to bind to playerPort ${playerPort}...`);
    const isSignalingReady = await this.checkPortStatus(playerPort, 10000);
    if (!isSignalingReady) {
      const errorMsg = signalingStderr.trim()
        ? `Signaling server health check failed on playerPort ${playerPort}: ${signalingStderr.trim()}`
        : `Signaling server health check failed on playerPort ${playerPort} (timed out after 10s)`;
      this.logger.error(errorMsg);
      if (signalingProcess && signalingProcess.pid) {
        this.killProcessTree(signalingProcess.pid);
      }
      throw new BadRequestException(errorMsg);
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

    if (!project.extractedPath) {
      this.logger.error(`Project "${project.name}" has no extractedPath recorded.`);
      if (signalingProcess && signalingProcess.pid) {
        this.killProcessTree(signalingProcess.pid);
      }
      throw new BadRequestException(
        `Project "${project.name}" has no extracted directory. The upload may have failed.`,
      );
    }

    // Find the UE build root — the directory containing Engine/ — which is the correct CWD.
    // The .sh launcher script and UE binary both expect to run from the build root,
    // not from Binaries/Linux/ where the binary lives.
    // We try to find build root from the executable path first; if no executable was found
    // during upload, fall back to the extracted root and search for a launcher script.
    let buildRoot: string | null = null;
    let absoluteExePath: string | null = null;

    if (project.executablePath) {
      absoluteExePath = path.resolve(project.extractedPath, project.executablePath);
      if (!fs.existsSync(absoluteExePath)) {
        this.logger.warn(
          `Executable path recorded as "${project.executablePath}" but file does not exist at ${absoluteExePath}. ` +
            `Will try to find a launcher script instead.`,
        );
        absoluteExePath = null;
      } else {
        this.ensureExecutable(absoluteExePath);
        buildRoot = this.findBuildRoot(path.dirname(absoluteExePath));
      }
    }

    // If no executable found or it was missing, search from the extracted root
    if (!buildRoot) {
      buildRoot = this.findBuildRoot(project.extractedPath);
    }

    if (!buildRoot) {
      this.logger.warn(
        `Could not locate build root (Engine/ directory) in ${project.extractedPath}. ` +
          `Falling back to extracted root as CWD.`,
      );
    }
    const ueCwd = buildRoot || project.extractedPath;
    this.logger.log(`UE build root (CWD): ${ueCwd}`);

    // Create Saved/Logs/ and Config/ directories — UE needs these to initialize properly.
    this.prepareUEDirectories(ueCwd);

    // Find the .sh launcher script. Running the .sh is preferred over the raw binary
    // because it respects the build's own environment setup and is compatible with
    // custom UE builds that may have additional launch logic.
    const launcherScript = this.findLauncherScript(ueCwd);

    // If no executable was found during upload, try to extract one from the launcher script
    if (!absoluteExePath && launcherScript) {
      absoluteExePath = this.extractBinaryPathFromScript(launcherScript);
      if (absoluteExePath && !fs.existsSync(absoluteExePath)) {
        this.logger.warn(
          `Binary path extracted from launcher script (${absoluteExePath}) does not exist. ` +
            `Will rely on launcher script to find the binary.`,
        );
        absoluteExePath = null;
      }
      if (absoluteExePath) {
        this.ensureExecutable(absoluteExePath);
      }
    }

    // Final check: we need either a launcher script or an executable to proceed
    if (!launcherScript && !absoluteExePath) {
      this.logger.error(
        `Project "${project.name}" has no executablePath and no launcher script found in ${ueCwd}. ` +
          `The upload scan did not find a valid executable, and no .sh/.bat launcher was detected. ` +
          `Ensure your packaged build contains either a project binary or a launcher script.`,
      );
      if (signalingProcess && signalingProcess.pid) {
        this.killProcessTree(signalingProcess.pid);
      }
      throw new BadRequestException(
        `No Unreal Engine executable or launcher script found in project "${project.name}". ` +
          `Ensure your packaged build contains a project binary (with +x permission on Linux) ` +
          `or a .sh launcher script at the build root level.`,
      );
    }

    // Ensure the launcher script is executable.
    // On Linux: extracted archives strip Unix permission bits — chmod +x is required.
    // On Windows: .bat files don't need special permissions.
    if (launcherScript && this.isLinux) {
      try {
        fs.chmodSync(launcherScript, 0o755);
        this.logger.log(`[Launcher] Ensured execute permission: ${launcherScript}`);
        // Log the script content for debugging
        try {
          const scriptContent = fs.readFileSync(launcherScript, 'utf-8');
          this.logger.log(`[Launcher] Script content:\n${scriptContent}`);
        } catch {}
      } catch {
        // Non-fatal — the spawn will fail with a clear error if the script isn't executable
      }
    }

    // Build the PixelStreaming connection flags — version-aware (UE 5.5+ vs earlier)
    // Try reading Build.version from disk first, fall back to the version stored in the DB at upload time.
    // This is critical because readBuildVersion may fail if the build root is misdetected.
    const diskVersion = this.readBuildVersion(ueCwd);
    const dbVersionStr = project.version; // e.g. "UE 5.6" or "Unknown"
    let version = diskVersion;
    if (!version && dbVersionStr && dbVersionStr.startsWith('UE ')) {
      const parts = dbVersionStr.replace('UE ', '').split('.');
      const major = parseInt(parts[0], 10);
      const minor = parseInt(parts[1], 10);
      if (!isNaN(major)) {
        version = { major, minor: isNaN(minor) ? 0 : minor };
        this.logger.log(
          `[Version] Using DB-stored version as fallback: ${dbVersionStr} (major=${major}, minor=${version.minor})`,
        );
      }
    }
    this.logger.log(
      `[Version] diskVersion=${diskVersion ? `UE ${diskVersion.major}.${diskVersion.minor}` : 'null'} dbVersion="${dbVersionStr}" resolved=${version ? `UE ${version.major}.${version.minor}` : 'null'}`,
    );
    const pixelStreamingArgs = this.getPixelStreamingArgs(streamerPort, version);

    // Encoder tuning flags
    const encoderArgs = [
      '-PixelStreamingEncoderCodec=H264',
      '-PixelStreamingWebRTCFps=60',
      '-PixelStreamingEncoderMinQP=1',
      '-PixelStreamingEncoderMaxQP=28',
      '-PixelStreamingEncoderTargetBitrate=20000',
      '-PixelStreamingEncoderMaxBitrate=50000',
      '-PixelStreamingEncoderRateControl=CBR',
    ];

    // Resolution flags
    const resolutionArgs = ['-ForceRes', '-ResX=1920', '-ResY=1080'];

    // Audio/platform flags — -RenderOffscreen is mandatory for headless server rendering
    // -vulkan: UE 5.6+ requires Vulkan (OpenGL is deprecated). Mesa's lavapipe provides
    // software Vulkan via the VK_ICD_FILENAMES env var set in getUEEnvironment().
    // -log: forces UE to write a log file under Saved/Logs/ for crash diagnostics.
    const platformArgs = this.isLinux
      ? ['-RenderOffscreen', '-vulkan', '-nosound', '-log']
      : ['-RenderOffscreen', '-AudioMixer', '-Windowed', '-log'];

    const ueArgs = [
      '-unattended',
      ...pixelStreamingArgs,
      ...encoderArgs,
      ...resolutionArgs,
      ...platformArgs,
    ];

    // Build the environment variables for the UE process (Vulkan/Mesa on Linux)
    // On Linux, start Xvfb first to provide a virtual display for rendering.
    let xvfbResult: { display: string; process: any } | null = null;
    if (this.isLinux) {
      xvfbResult = this.startXvfb();
      // Give Xvfb a moment to bind
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const display = xvfbResult?.display;
    const ueEnv = this.getUEEnvironment(display);

    this.logger.log(`UE launch args: ${ueArgs.join(' ')}`);
    this.logger.log(`Launcher script: ${launcherScript || '(none — will spawn binary directly)'}`);
    this.logger.log(`UE env vars: ${Object.keys(ueEnv).join(', ') || '(inherited)'}`);

    // On Linux, if the backend process is running as root (UID 0), drop root privileges to UID/GID 1000
    // because Unreal Engine binaries explicitly refuse to run with root privileges and exit with SIGABRT.
    const spawnOptions: any = {
      cwd: ueCwd,
      env: { ...process.env, ...ueEnv },
    };
    if (this.isLinux && process.getuid && process.getuid() === 0) {
      this.logger.warn(
        `Backend is running as root (UID 0). Dropping child process privileges to UID/GID 1000 for Unreal Engine.`,
      );
      spawnOptions.uid = 1000;
      spawnOptions.gid = 1000;
    }

    let ueProcess: any;
    let pid: number;

    try {
      if (launcherScript) {
        // Primary path: run the platform launcher script with our appended flags.
        // Linux: .sh script invokes the ELF binary with the correct project name.
        // Windows: .bat script invokes the .exe with the correct project name.
        // The launcher handles project name resolution and engine-specific setup.
        // We append PixelStreaming, encoder, resolution, and platform flags.
        this.logger.log(`Spawning UE via launcher script: ${launcherScript} (CWD: ${ueCwd})`);
        ueProcess = spawn(launcherScript, ueArgs, spawnOptions);
      } else {
        // Fallback: no launcher script found — spawn the binary directly with project name prefix.
        // On Linux, the binary requires the project name as the first argument.
        // On Windows, same pattern — .exe expects ProjectName before flags.
        // absoluteExePath is guaranteed non-null here: the validation above ensures
        // either launcherScript or absoluteExePath exists, and we're in the !launcherScript branch.
        const exePath = absoluteExePath!;
        const projectName = this.parseLauncherScript(ueCwd);
        const positionalArgs = projectName ? [projectName] : [];
        this.logger.log(`No launcher script found. Spawning binary directly: ${exePath}`);

        const isWindowsExeOnLinux = this.isLinux && exePath.toLowerCase().endsWith('.exe');
        if (isWindowsExeOnLinux) {
          const wineBin = fs.existsSync('/usr/bin/wine64') ? 'wine64' : 'wine';
          ueProcess = spawn(wineBin, [exePath, ...positionalArgs, ...ueArgs], spawnOptions);
        } else {
          ueProcess = spawn(exePath, [...positionalArgs, ...ueArgs], spawnOptions);
        }
      }

      ueProcess.stdout?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          this.logger.log(`[UE-PID ${ueProcess.pid}][stdout]: ${msg}`);
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
        const exitReason = `UE process exited with code=${code}, signal=${signal}`;
        this.logger.error(`[UE-PID ${ueProcess.pid}] ${exitReason}. Marking instance as ERROR.`);

        // Attempt to read the UE log file for crash diagnostics
        // UE writes to Saved/Logs/<ProjectName>.log when -log flag is passed
        try {
          const savedLogsDir = path.join(ueCwd, 'Saved', 'Logs');
          if (fs.existsSync(savedLogsDir)) {
            const logFiles = fs.readdirSync(savedLogsDir)
              .filter(f => f.endsWith('.log'))
              .sort((a, b) => {
                const statA = fs.statSync(path.join(savedLogsDir, a));
                const statB = fs.statSync(path.join(savedLogsDir, b));
                return statB.mtimeMs - statA.mtimeMs;
              });
            if (logFiles.length > 0) {
              const latestLog = path.join(savedLogsDir, logFiles[0]);
              const logContent = fs.readFileSync(latestLog, 'utf-8');
              // Log the last 50 lines which contain the crash info
              const lines = logContent.split('\n');
              const lastLines = lines.slice(-50).join('\n');
              this.logger.error(
                `[UE-PID ${ueProcess.pid}] === UE LOG FILE (${latestLog}) — last 50 lines ===\n${lastLines}\n[UE-PID ${ueProcess.pid}] === END UE LOG ===`,
              );
            } else {
              this.logger.warn(`[UE-PID ${ueProcess.pid}] No .log files found in ${savedLogsDir}`);
            }
          }
        } catch (logErr: any) {
          this.logger.warn(`[UE-PID ${ueProcess.pid}] Failed to read UE log: ${logErr.message}`);
        }

        const proc = this.activeProcesses.get(project.id);
        if (proc) {
          proc.lastError =
            code !== null && code !== 0
              ? `Unreal Engine process crashed (exit code ${code}). Ensure the build is a valid Linux binary with Vulkan rendering support and Mesa lavapipe installed.`
              : `Unreal Engine process exited unexpectedly (signal=${signal}).`;
        }

        this.prisma.instance
          .updateMany({
            where: { projectId: project.id, status: 'RUNNING' },
            data: { status: 'ERROR' },
          })
          .catch(() => {});
        this.prisma.project
          .update({
            where: { id: project.id },
            data: { status: 'STOPPED' },
          })
          .catch(() => {});

        // Keep the signaling server alive briefly so connected clients can detect
        // the disconnection gracefully rather than hitting an abrupt 1006 close.
        // Clean up signaling and xvfb after a short grace period.
        if (signalingProcess && signalingProcess.pid) {
          setTimeout(() => {
            this.logger.log(
              `Grace period over. Killing signaling process PID ${signalingProcess.pid} for project ${project.id}`,
            );
            this.killProcessTree(signalingProcess.pid);
            // Also kill the Xvfb process for this instance
            const p = this.activeProcesses.get(project.id);
            if (p?.xvfbProcess?.pid) {
              this.killProcessTree(p.xvfbProcess.pid);
            }
          }, 5000);
        }

        // Auto-restart: if this project has a public share slug (viewers depend on it),
        // automatically restart the UE instance after a brief cooldown.
        // Cancel any existing restart timer first.
        if (proc?.restartTimer) {
          clearTimeout(proc.restartTimer);
        }
        if (project.shareSlug) {
          this.logger.log(
            `Project ${project.id} has a public share link — scheduling auto-restart in 10s`,
          );
          this.autoRestartUE(project.id, userId);
        } else {
          this.logger.log(`Project ${project.id} has no public share link — not auto-restarting`);
        }
      });

      pid = ueProcess.pid;
      if (!pid) {
        throw new Error('UE process spawned but PID is null/undefined');
      }
      this.logger.log(`Successfully spawned UE process with PID ${pid}`);

      // Post-spawn health check: wait briefly and verify the UE process is still alive.
      // UE binaries crash immediately if they lack GPU/Vulkan support, rendering libs,
      // or if the binary is corrupt. Detecting this early gives the user a clear error
      // instead of a silent "stream never starts" experience.
      const HEALTH_CHECK_DELAY_MS = 5000;
      await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_DELAY_MS));

      if (ueProcess.exitCode !== null) {
        const exitCode = ueProcess.exitCode;
        const proc = this.activeProcesses.get(project.id);
        const errorMsg =
          proc?.lastError ||
          `Unreal Engine process exited immediately after launch (exit code ${exitCode}). ` +
            `Ensure the packaged build is a valid Linux binary with Vulkan rendering support (Mesa lavapipe). ` +
            `Check backend logs for [UE-PID ${pid}] output.`;
        this.logger.error(`UE process health check failed: ${errorMsg}`);

        // Mark instance as ERROR
        await this.prisma.instance
          .updateMany({
            where: { projectId: project.id, status: 'RUNNING' },
            data: { status: 'ERROR' },
          })
          .catch(() => {});
        await this.prisma.project
          .update({ where: { id: project.id }, data: { status: 'STOPPED' } })
          .catch(() => {});

        // Clean up signaling process
        if (signalingProcess && signalingProcess.pid) {
          this.killProcessTree(signalingProcess.pid);
        }
        this.activeProcesses.delete(project.id);

        throw new BadRequestException(errorMsg);
      }
      this.logger.log(
        `UE process health check passed — PID ${pid} is alive after ${HEALTH_CHECK_DELAY_MS}ms`,
      );
    } catch (err: any) {
      // Don't double-wrap errors that are already a clear user-facing message
      if (err instanceof BadRequestException) {
        throw err;
      }
      this.logger.error(`Failed to spawn Unreal Engine process: ${err.message}`);
      if (signalingProcess && signalingProcess.pid) {
        this.killProcessTree(signalingProcess.pid);
      }
      throw new BadRequestException(
        `Failed to launch Unreal Engine executable: ${err.message}. ` +
          `Ensure the binary is a valid ${this.isLinux ? 'Linux ELF' : 'Windows'} executable with Vulkan rendering support (Mesa lavapipe on headless Linux) and not corrupted.`,
      );
    }

    // Save processes in memory map
    // Instance lifecycle is decoupled from any browser/WebSocket connection:
    // closing a tab, refreshing the page, or zero viewers will NOT stop this instance.
    // Auto-restart is enabled for projects with a public share slug.
    this.activeProcesses.set(projectId, {
      signalingProcess,
      ueProcess,
      xvfbProcess: xvfbResult?.process,
      playerPort,
      streamerPort,
      clients: 0,
      ownerId: userId,
      autoRestart: !!project.shareSlug,
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

  async getInstanceHealth(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      include: { instances: true },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    const activeInstance = project.instances?.find((i: any) => i.status === 'RUNNING');
    const proc = this.activeProcesses.get(projectId);

    // Check if the UE process is still alive
    let ueAlive = false;
    let signalingAlive = false;
    if (proc) {
      ueAlive = proc.ueProcess && proc.ueProcess.exitCode === null;
      signalingAlive = proc.signalingProcess && proc.signalingProcess.exitCode === null;
    }

    // If UE process has died but DB still shows RUNNING, fix the state
    if (activeInstance && proc && !ueAlive) {
      this.logger.warn(
        `Instance ${activeInstance.id} DB says RUNNING but UE process is dead (exitCode=${proc.ueProcess?.exitCode}). Fixing state.`,
      );
      await this.prisma.instance
        .update({ where: { id: activeInstance.id }, data: { status: 'ERROR' } })
        .catch(() => {});
      await this.prisma.project
        .update({ where: { id: projectId }, data: { status: 'STOPPED' } })
        .catch(() => {});

      // Cleanup
      if (proc.signalingProcess?.pid) {
        this.killProcessTree(proc.signalingProcess.pid);
      }
      this.activeProcesses.delete(projectId);

      return {
        status: 'ERROR',
        error: proc.lastError || 'Unreal Engine process crashed after startup',
        port: activeInstance.port,
      };
    }

    return {
      status: activeInstance ? 'RUNNING' : project.status,
      port: activeInstance?.port || null,
      ueAlive,
      signalingAlive,
      error: proc?.lastError || null,
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
      // Cancel any pending auto-restart timer
      if (proc.restartTimer) {
        clearTimeout(proc.restartTimer);
        this.logger.log(`Cancelled pending auto-restart for project ${project.id}`);
      }
      if (proc.xvfbProcess && proc.xvfbProcess.pid) {
        this.logger.log(`Killing Xvfb process PID ${proc.xvfbProcess.pid}`);
        try {
          this.killProcessTree(proc.xvfbProcess.pid);
        } catch (e) {
          this.logger.warn(`Could not kill Xvfb process ${proc.xvfbProcess.pid}: ${e.message}`);
        }
      }
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

  // Auto-restart a UE instance after a crash.
  // This is used for public share links that need 24/7 uptime. When the UE process exits
  // (crashes, OOM, rendering failure), this method waits a brief cooldown period, then
  // attempts to re-spawn the instance. It preserves the existing signaling server port
  // allocation so the public URL remains valid.
  private autoRestartUE(projectId: string, userId: string): void {
    const COOLDOWN_MS = 10000;

    const timer = setTimeout(async () => {
      const proc = this.activeProcesses.get(projectId);
      if (!proc || proc.ueProcess?.exitCode === null) {
        return; // Already restarted or still alive
      }

      try {
        this.logger.log(`Auto-restarting UE instance for project ${projectId}...`);

        // Check the project still exists and has a share slug (public instance)
        const project = await this.prisma.project.findFirst({
          where: { id: projectId },
        });
        if (!project || !project.shareSlug) {
          this.logger.log(
            `Project ${projectId} no longer has a share slug — skipping auto-restart`,
          );
          return;
        }

        // Clean up old signaling server and xvfb
        if (proc.signalingProcess?.pid) {
          this.killProcessTree(proc.signalingProcess.pid);
        }
        if (proc.xvfbProcess?.pid) {
          this.killProcessTree(proc.xvfbProcess.pid);
        }
        this.activeProcesses.delete(projectId);

        // Re-spawn using startInstance (which re-allocates ports and spawns fresh processes)
        await this.startInstance(projectId, userId);
        this.logger.log(`Auto-restart succeeded for project ${projectId}`);
      } catch (err: any) {
        this.logger.error(
          `Auto-restart failed for project ${projectId}: ${err.message}. ` +
            `The stream will not resume until manually restarted.`,
        );
        this.activeProcesses.delete(projectId);
      }
    }, COOLDOWN_MS);

    // Store the timer so it can be cancelled if the instance is manually stopped
    const proc = this.activeProcesses.get(projectId);
    if (proc) {
      proc.restartTimer = timer;
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
    throw new BadRequestException(
      'No free ports available in the range 8800-9100. All ports are in use.',
    );
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
    throw new BadRequestException(
      'Signaling server directory with compiled dist/index.js not found. Run the signaling server build first.',
    );
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

  // Read Engine/Build/Build.version from a packaged UE build.
  // Returns { major, minor } or null if the file is missing/unreadable.
  private readBuildVersion(buildRoot: string): { major: number; minor: number } | null {
    const versionPath = path.join(buildRoot, 'Engine', 'Build', 'Build.version');
    this.logger.log(`[Version] Reading Build.version from: ${versionPath}`);
    try {
      if (fs.existsSync(versionPath)) {
        const raw = fs.readFileSync(versionPath, 'utf-8');
        this.logger.log(`[Version] Build.version content: ${raw.trim()}`);
        const version = JSON.parse(raw);
        const major = version.MajorVersion ?? 0;
        const minor = version.MinorVersion ?? 0;
        this.logger.log(
          `[Version] Engine version: UE ${major}.${minor} ` +
            `(MajorVersion=${major}, MinorVersion=${minor})`,
        );
        return { major, minor };
      } else {
        this.logger.warn(`[Version] Build.version NOT FOUND at ${versionPath}`);
      }
    } catch (err: any) {
      this.logger.warn(`[Version] Failed to read Build.version at ${versionPath}: ${err.message}`);
    }
    return null;
  }

  // Auto-detect UE version at upload time by scanning for Engine/Build/Build.version.
  // At upload time we don't know the build root, so we walk subdirectories looking for it.
  // Returns a string like "UE 5.6" or "Unknown" if detection fails.
  private detectUEVersion(dir: string): string {
    // Try the direct path first (dir might already be the build root)
    const direct = this.readBuildVersion(dir);
    if (direct) return `UE ${direct.major}.${direct.minor}`;

    // Walk one level of subdirectories to find Engine/Build/Build.version
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'Engine') {
          // Found Engine/ at this level — Build.version should be right here
          const ver = this.readBuildVersion(dir);
          if (ver) return `UE ${ver.major}.${ver.minor}`;
        }
        // Check one level deeper
        const subDir = path.join(dir, entry.name);
        const subVer = this.readBuildVersion(subDir);
        if (subVer) return `UE ${subVer.major}.${subVer.minor}`;
      }
    } catch {
      // Ignore scan errors
    }

    this.logger.warn(`Could not auto-detect UE version from ${dir}`);
    return 'Unknown';
  }

  // Return the correct PixelStreaming connection flags for the given engine version.
  //
  // Flag naming changed between UE versions:
  //   - UE 5.4 and earlier: -PixelStreamingIP + -PixelStreamingPort (two separate flags)
  //   - UE 5.5+:            -PixelStreamingSignallingURL (single connection string)
  //
  // This is the single place to update when Epic changes flag names in a future version.
  private getPixelStreamingArgs(
    streamerPort: number,
    version: { major: number; minor: number } | null,
  ): string[] {
    if (version && (version.major > 5 || (version.major === 5 && version.minor >= 5))) {
      // UE 5.5+ — single-flag connection string
      return [`-PixelStreamingSignallingURL=ws://127.0.0.1:${streamerPort}`];
    }

    // UE 5.4 and earlier — two separate flags
    // Also the safe fallback for missing/unknown versions, since the older
    // flags are more widely recognized across all UE5 releases.
    return [`-PixelStreamingIP=127.0.0.1`, `-PixelStreamingPort=${streamerPort}`];
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
  // Linux: file must have at least one execute permission bit set (X_OK) or must be
  //        a Linux ELF binary (starts with \x7fELF magic bytes), and must not be
  //        a shared library (.so), script, or other non-binary file.
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
      // Allow .exe files on Linux for Wine compatibility (e.g., Windows builds uploaded to Linux server)
      if (lower.endsWith('.exe')) {
        return true;
      }
      try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
      } catch {
        // If it doesn't have execution permissions, check if it's an ELF binary by reading its magic bytes.
        try {
          const fd = fs.openSync(filePath, 'r');
          const buffer = Buffer.alloc(4);
          const bytesRead = fs.readSync(fd, buffer, 0, 4, 0);
          fs.closeSync(fd);
          if (
            bytesRead === 4 &&
            buffer[0] === 0x7f &&
            buffer[1] === 0x45 && // 'E'
            buffer[2] === 0x4c && // 'L'
            buffer[3] === 0x46 // 'F'
          ) {
            return true;
          }
        } catch {
          // Ignore open/read errors
        }
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
      const projectDir = path.dirname(filePath);
      execSync(`chmod -R 775 "${projectDir}"`, { stdio: 'ignore' });
      fs.chmodSync(filePath, 0o755);
      this.logger.log(`Ensured executable permissions recursively on: ${projectDir}`);
    } catch {
      try {
        fs.chmodSync(filePath, 0o755);
      } catch {}
    }
  }

  // Fix permissions on all .sh scripts and ELF binaries after extraction.
  // ZIP and RAR archives do not preserve Unix permission bits, so extracted files
  // lose their +x bit. This walks the extracted directory and sets +x on:
  //   - All .sh files (launcher scripts)
  //   - All ELF binaries (detected by \x7fELF magic bytes)
  // This runs once at upload time so startInstance() doesn't need to fix permissions later.
  private fixExtractedPermissions(dir: string): void {
    if (!this.isLinux) return;

    let fixedCount = 0;
    const walk = (currentDir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          // Skip Engine/ internals — those don't need +x
          if (entry.name === 'Engine') continue;
          walk(fullPath);
        } else if (entry.isFile()) {
          const lower = entry.name.toLowerCase();
          let needsChmod = false;

          // .sh launcher scripts always need +x
          if (lower.endsWith('.sh')) {
            needsChmod = true;
          }

          // ELF binaries need +x (check magic bytes)
          if (!needsChmod && !lower.endsWith('.so') && !lower.endsWith('.pak')) {
            try {
              const fd = fs.openSync(fullPath, 'r');
              const buf = Buffer.alloc(4);
              fs.readSync(fd, buf, 0, 4, 0);
              fs.closeSync(fd);
              if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
                needsChmod = true;
              }
            } catch {
              // Ignore read errors
            }
          }

          if (needsChmod) {
            try {
              fs.chmodSync(fullPath, 0o755);
              fixedCount++;
            } catch {
              // Non-fatal — startInstance will also call ensureExecutable as a fallback
            }
          }
        }
      }
    };

    try {
      walk(dir);
      if (fixedCount > 0) {
        this.logger.log(`Fixed permissions on ${fixedCount} file(s) in ${dir}`);
      }
    } catch (err: any) {
      this.logger.warn(`Failed to fix extracted permissions in ${dir}: ${err.message}`);
    }
  }

  // Remove the Zone.Identifier alternate data stream from all files in a directory (Windows only).
  // Windows attaches Zone.Identifier:3 ("downloaded from the internet") to files saved from
  // HTTP uploads or extracted from downloaded archives. This causes SmartScreen / "Open File -
  // Security Warning" popups when launching .exe files. PowerShell's Unblock-File strips this
  // ADS cleanly and is the Microsoft-recommended approach.
  private removeZoneIdentifier(dir: string): void {
    if (process.platform !== 'win32') return;

    try {
      // Unblock-File -Path <dir> -Recurse removes Zone.Identifier from every file under the dir.
      // -ErrorAction SilentlyContinue ensures we never fail the upload over a missing ADS.
      execSync(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-ChildItem -Path '${dir}' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File"`,
        { stdio: 'ignore', timeout: 30000 },
      );
      this.logger.log(`Removed Zone.Identifier (Mark-of-the-Web) from all files in ${dir}`);
    } catch (err: any) {
      // Non-fatal: the upload still works, but SmartScreen may prompt on launch.
      this.logger.warn(`Could not remove Zone.Identifier from ${dir}: ${err.message}`);
    }
  }

  // Walk up from the binary's directory to find the UE build root.
  // The build root is the directory containing Engine/ — e.g., Linux/ in a packaged build.
  // UE binaries and .sh launchers expect to run from this directory.
  private findBuildRoot(startDir: string): string | null {
    let dir = startDir;
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(dir, 'Engine'))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
    return null;
  }

  // Find the launcher script in the build root or one level of subdirectories.
  // On Linux: UE builds ship with a .sh launcher (e.g., ArchVizExplorer.sh).
  // On Windows: UE builds ship with a .bat launcher (e.g., ArchVizExplorer.bat).
  // Running the launcher directly is preferred over calling the raw binary because
  // it handles project name resolution and may contain additional setup logic.
  //
  // Search order:
  //   1. Build root directory (most common location)
  //   2. One level of subdirectories (e.g., MyProject/MyProject.sh)
  //
  // Scripts inside Engine/ or Build/ are excluded — those are build tools, not launchers.
  // Returns the full path to the launcher script, or null if not found.
  private findLauncherScript(buildRoot: string): string | null {
    const ext = this.isLinux ? '.sh' : '.bat';

    // Scripts to skip — these are build/engine tools, not project launchers
    const excludedScripts = [
      'Build.sh',
      'Build.bat',
      'Setup.sh',
      'Setup.bat',
      'CompileShaders',
      'GenerateProjectFiles',
      'RunUAT',
      'RunCook',
    ];

    const isExcluded = (name: string): boolean => {
      const lower = name.toLowerCase();
      return excludedScripts.some((excl) => lower.startsWith(excl.toLowerCase()));
    };

    try {
      // PASS 1: Scan build root (most common — e.g., ArchVizExplorer.sh sits at root)
      const rootEntries = fs.readdirSync(buildRoot, { withFileTypes: true });
      for (const entry of rootEntries) {
        if (entry.isFile() && entry.name.endsWith(ext) && !isExcluded(entry.name)) {
          const fullPath = path.join(buildRoot, entry.name);
          this.logger.log(`Found ${ext} launcher script at build root: ${entry.name}`);
          return fullPath;
        }
      }

      // PASS 2: Scan one level of subdirectories (e.g., MyProject/MyProject.sh)
      for (const entry of rootEntries) {
        if (!entry.isDirectory()) continue;
        // Skip Engine/ and Build/ — those contain engine tools, not project launchers
        if (entry.name === 'Engine' || entry.name === 'Build') continue;

        const subDir = path.join(buildRoot, entry.name);
        try {
          const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (subEntry.isFile() && subEntry.name.endsWith(ext) && !isExcluded(subEntry.name)) {
              const fullPath = path.join(subDir, subEntry.name);
              this.logger.log(
                `Found ${ext} launcher script in subdirectory ${entry.name}/: ${subEntry.name}`,
              );
              return fullPath;
            }
          }
        } catch {
          // Skip unreadable subdirectories
        }
      }
    } catch (err: any) {
      this.logger.warn(`Failed to scan for launcher scripts in ${buildRoot}: ${err.message}`);
    }
    return null;
  }

  // Parse the launcher script to extract the project name (used as fallback for binary spawn).
  // UE packaged builds generate launcher scripts in several formats:
  //
  // Linux (.sh):
  //   "$SCRIPT_DIR/MyProject/Binaries/Linux/MyProject-Linux-Shipping" MyProject "$@"
  //   exec "$DIR/MyProject/Binaries/Linux/MyProject" "$@"
  //   ./MyProject/Binaries/Linux/MyProject-Test MyProject -game "$@"
  //
  // Windows (.bat):
  //   "%~dp0MyProject\Binaries\Win64\MyProject.exe" MyProject %*
  //   "%~dp0MyProject\Binaries\Win64\MyProject-Win64-Shipping.exe" MyProject %*
  //
  // The project name is the first positional argument right after the binary path.
  // On some builds it's omitted (relying on UE to infer from the binary name).
  private parseLauncherScript(buildRoot: string): string | null {
    const ext = this.isLinux ? '.sh' : '.bat';
    try {
      const entries = fs.readdirSync(buildRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(ext)) {
          const content = fs.readFileSync(path.join(buildRoot, entry.name), 'utf-8');
          const lines = content.split('\n');

          for (const line of lines) {
            const trimmed = line.trim();
            // Skip comments and empty lines
            if (!trimmed || trimmed.startsWith('#')) continue;

            // Pattern 1: Quoted binary path + project name
            const quotedMatch = trimmed.match(/["']([^"']+)["']\s+(.+)/);
            if (quotedMatch) {
              const args = quotedMatch[2].trim().split(/\s+/);
              // Find first arg that looks like a project name (not a flag like -game, -game)
              for (const arg of args) {
                if (arg.startsWith('-')) continue;
                if (arg === '"$@"' || arg === '$@' || arg === '%*' || arg === '"$*"') continue;
                const clean = arg.replace(/["']/g, '');
                if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(clean)) {
                  this.logger.log(
                    `Parsed launcher script ${entry.name}: project name = "${clean}"`,
                  );
                  return clean;
                }
              }
            }

            // Pattern 2: Unquoted path or exec command
            const unquotedMatch = trimmed.match(/(?:exec\s+)?(\S+\/\S+|[.][/]\S+)\s+(.+)/);
            if (unquotedMatch) {
              const args = unquotedMatch[2].trim().split(/\s+/);
              for (const arg of args) {
                if (arg.startsWith('-')) continue;
                if (arg === '"$@"' || arg === '$@' || arg === '%*' || arg === '"$*"') continue;
                const clean = arg.replace(/["']/g, '');
                if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(clean)) {
                  this.logger.log(
                    `Parsed launcher script ${entry.name}: project name = "${clean}"`,
                  );
                  return clean;
                }
              }
            }
          }

          // Last resort: try to extract project name from the binary filename itself
          // e.g., MyProject-Linux-Shipping -> MyProject
          const binaryNameMatch = content.match(
            /Binaries\/[^"'\s]*?([A-Za-z_][A-Za-z0-9_]*?)(?:-Linux|-Win64|-Shipping|-Test|-Debug)?["']/,
          );
          if (binaryNameMatch) {
            this.logger.log(
              `Parsed launcher script ${entry.name}: project name from binary = "${binaryNameMatch[1]}"`,
            );
            return binaryNameMatch[1];
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`Failed to parse launcher scripts in ${buildRoot}: ${err.message}`);
    }
    return null;
  }

  // Extract the full binary path from a launcher script.
  // When no executable was found during upload (e.g., the binary was nested or lacked +x),
  // this method parses the .sh/.bat script to find the binary path that the script invokes.
  // Returns the resolved absolute path, or null if parsing fails.
  private extractBinaryPathFromScript(scriptPath: string): string | null {
    try {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Match quoted binary path: "$SCRIPT_DIR/.../Binary" or "$DIR/.../Binary"
        const quotedMatch = trimmed.match(/["']([^"']+)["']/);
        if (quotedMatch) {
          const rawPath = quotedMatch[1];
          // Resolve shell variables like $SCRIPT_DIR, $DIR, $(dirname "$0")
          const resolved = rawPath
            .replace(/\$SCRIPT_DIR/g, path.dirname(scriptPath))
            .replace(/\$DIR/g, path.dirname(scriptPath))
            .replace(/\$\{?DIR\}?/g, path.dirname(scriptPath))
            .replace(/\$0/g, scriptPath)
            .replace(/\$\(dirname ["']?\$0["']?\)/g, path.dirname(scriptPath));

          if (fs.existsSync(resolved)) {
            this.logger.log(`Extracted binary path from launcher script: ${resolved}`);
            return resolved;
          }

          // Try relative to script directory
          const relativeResolved = path.resolve(path.dirname(scriptPath), resolved);
          if (fs.existsSync(relativeResolved)) {
            this.logger.log(
              `Extracted binary path (relative) from launcher script: ${relativeResolved}`,
            );
            return relativeResolved;
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`Failed to extract binary path from ${scriptPath}: ${err.message}`);
    }
    return null;
  }

  // Create Required/Logs and Config directories inside the build root.
  // UE packaged builds need these directories to initialize properly — without them,
  // the engine may fail to create log files or read config during startup.
  private prepareUEDirectories(buildRoot: string): void {
    const dirs = [
      path.join(buildRoot, 'Saved', 'Logs'),
      path.join(buildRoot, 'Config'),
      path.join(buildRoot, 'Saved'),
    ];
    for (const dir of dirs) {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
          this.logger.log(`Created UE directory: ${dir}`);
        }
      } catch (err: any) {
        this.logger.warn(`Failed to create directory ${dir}: ${err.message}`);
      }
    }
  }

  // Build the environment variables for the UE child process.
  // On Linux, Mesa/Vulkan software rendering requires specific env vars to function
  // on headless servers without a real GPU. These tell Mesa to use the lavapipe/llvmpipe
  // software rasterizer and where to find the Vulkan ICD (Installable Client Driver).
  private getUEEnvironment(display?: string): Record<string, string> {
    if (!this.isLinux) return {};

    // Auto-detect the Vulkan ICD (Installable Client Driver) path.
    // The hardcoded path may not exist on all distros — find the lavapipe ICD dynamically.
    let vkIcdPath = process.env.VK_ICD_FILENAMES || '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json';
    if (!fs.existsSync(vkIcdPath)) {
      try {
        const icdDir = '/usr/share/vulkan/icd.d';
        if (fs.existsSync(icdDir)) {
          const icdFiles = fs
            .readdirSync(icdDir)
            .filter((f) => f.includes('lvp') && f.endsWith('.json'));
          if (icdFiles.length > 0) {
            vkIcdPath = path.join(icdDir, icdFiles[0]);
            this.logger.log(`Auto-detected Vulkan ICD: ${vkIcdPath}`);
          } else {
            // Try any swrast or llvmpipe ICD
            const anyIcd = fs.readdirSync(icdDir).filter((f) => f.endsWith('.json'));
            if (anyIcd.length > 0) {
              vkIcdPath = path.join(icdDir, anyIcd[0]);
              this.logger.log(`Using fallback Vulkan ICD: ${vkIcdPath}`);
            }
          }
        }
      } catch {
        this.logger.warn(`Could not auto-detect Vulkan ICD, using default: ${vkIcdPath}`);
      }
    }

    const env: Record<string, string> = {
      VK_ICD_FILENAMES: vkIcdPath,
      GALLIUM_DRIVER: 'llvmpipe',
      MESA_GL_VERSION_OVERRIDE: '4.5',
      MESA_LOADER_DRIVER_OVERRIDE: 'lvp',
      RADV_PERFTEST: 'gpl',
      XDG_RUNTIME_DIR: '/tmp/runtime-root',
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: process.env.HOME || '/tmp',
    };

    if (display) {
      env.DISPLAY = display;
    }

    return env;
  }

  // Start Xvfb (X Virtual Framebuffer) on Linux for headless rendering.
  // UE packaged builds require a display server to initialize the rendering pipeline,
  // even when using -RenderOffscreen. On a GPU-less server, Xvfb provides a virtual
  // display backed by Mesa/llvmpipe software rendering.
  // Returns the display string (e.g., ":99") or null if xvfb failed to start.
  private startXvfb(): { display: string; process: any } | null {
    if (!this.isLinux) return null;

    // Check if display :99 is already bound (e.g. from a previous instance or auto-restart)
    const displayNum = 99;
    const display = `:${displayNum}`;

    // Check if something is already listening on this display
    try {
      const sock = require('net');
      const lockPath = `/tmp/.X${displayNum}-lock`;
      if (fs.existsSync(lockPath)) {
        const pid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
        if (!isNaN(pid)) {
          // Check if that PID is still alive
          try {
            process.kill(pid, 0); // signal 0 = check existence
            this.logger.log(`[Xvfb] Display ${display} already in use by PID ${pid} — reusing`);
            return { display, process: { pid, kill: () => {} } }; // dummy handle
          } catch {
            // PID is dead — stale lock file, clean it up
            this.logger.log(`[Xvfb] Stale lock file for display ${display} (dead PID ${pid}), cleaning up`);
            try { fs.unlinkSync(lockPath); } catch {}
          }
        }
      }
    } catch {}

    try {
      // Start Xvfb with a 1920x1080x24-bit color screen
      const xvfbProcess = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-ac'], {
        stdio: 'ignore',
        detached: true,
      });

      xvfbProcess.on('error', (err: Error) => {
        this.logger.error(`[Xvfb] Process error: ${err.message}`);
      });

      xvfbProcess.on('exit', (code: number | null) => {
        this.logger.warn(`[Xvfb] Process exited with code ${code}`);
      });

      this.logger.log(`[Xvfb] Started with PID ${xvfbProcess.pid} on display ${display}`);
      return { display, process: xvfbProcess };
    } catch (err: any) {
      this.logger.error(`[Xvfb] Failed to start: ${err.message}`);
      return null;
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
        // Cancel any pending auto-restart timer
        if (proc.restartTimer) {
          clearTimeout(proc.restartTimer);
        }
        if (proc.xvfbProcess && proc.xvfbProcess.pid) {
          try {
            this.killProcessTree(proc.xvfbProcess.pid);
          } catch {
            /* ignore */
          }
        }
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
