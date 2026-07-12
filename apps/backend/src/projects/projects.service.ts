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

@Injectable()
export class ProjectsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectsService.name);
  private activeProcesses = new Map<
    string,
    {
      signalingProcess?: any;
      ueProcess?: any;
      playerPort: number;
      streamerPort: number;
      clients: number;
      idleSeconds: number;
      ownerId: string;
    }
  >();
  private storagePath = path.resolve(process.cwd(), 'storage');

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    // Ensure storage folders exist
    const projectsDir = path.join(this.storagePath, 'projects');
    if (!fs.existsSync(projectsDir)) {
      fs.mkdirSync(projectsDir, { recursive: true });
      this.logger.log(`Created projects storage directory at ${projectsDir}`);
    }

    // Reset running instance states in DB to stopped on boot (prevents orphaned states)
    this.prisma.instance.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'STOPPED' },
    }).then(() => {
      this.logger.log('Reset all active instance states in database');
    }).catch(err => {
      this.logger.error(`Failed to reset instance states: ${err.message}`);
    });

    this.prisma.project.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'STOPPED' },
    }).then(() => {
      this.logger.log('Reset all active project states in database');
    }).catch(err => {
      this.logger.error(`Failed to reset project states: ${err.message}`);
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
        this.logger.log(`ZIP extraction complete — ${entries.length} entries extracted to ${projectDir}`);
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
        this.logger.log(`✅ Executable found and saved: ${relativeExePath} (absolute: ${exeFullPath})`);
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

    // Check if there is already a running instance
    let activeInstance = project.instances?.find((i) => i.status === 'RUNNING');
    let port = activeInstance?.port || null;

    if (!activeInstance) {
      // Auto-start the instance using the project owner's userId
      const startResult = await this.startInstance(project.id, project.userId);
      port = startResult.port;
    }

    return {
      id: project.id,
      name: project.name,
      version: project.version,
      status: 'RUNNING',
      port,
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

    // Allocate free ports starting from 8800
    const streamerPort = await this.findFreePort(8800, 8900);
    const playerPort = await this.findFreePort(streamerPort + 1, 9000);
    this.logger.log(`Allocated streamerPort ${streamerPort} and playerPort ${playerPort} for project ${project.name}`);

    // Verify signaling server is built before spawning
    const signalingDir = this.getSignalingDir();
    const jsPath = path.resolve(signalingDir, 'dist', 'index.js');
    if (!fs.existsSync(jsPath)) {
      throw new BadRequestException(
        `Signaling server not built. Expected ${jsPath} to exist. Run 'npm run build' in the signaling directory.`,
      );
    }
    this.logger.log(`Spawning Epic Games signaling server on streamerPort ${streamerPort}, playerPort ${playerPort}`);
    
    const maxPlayers = project.maxCCU || 3;
    const signalingArgs = [
      jsPath,
      '--no_config',
      '--streamer_port',
      streamerPort.toString(),
      '--player_port',
      playerPort.toString(),
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
    const isSignalingReady = await this.checkPortStatus(playerPort, 10000); // 10s timeout
    if (!isSignalingReady) {
      this.logger.error(`Signaling server failed to start on port ${playerPort} in time`);
      if (signalingProcess && signalingProcess.pid) {
        this.killProcessTree(signalingProcess.pid);
      }
      throw new BadRequestException('Signaling server health check failed on playerPort');
    }
    this.logger.log(`Signaling server TCP port ${playerPort} is bound. Verifying HTTP handler is ready...`);

    // HTTP health check: ensure the signaling server's REST API is responding
    const httpReady = await this.checkHttpReady(playerPort, 10000);
    if (!httpReady) {
      this.logger.warn(`Signaling server HTTP handler not ready on port ${playerPort}, proceeding anyway`);
    } else {
      this.logger.log(`Signaling server HTTP handler confirmed ready on port ${playerPort}`);
    }

    let ueProcess: any;
    let pid: number;

    if (!project.executablePath || !project.extractedPath) {
      // No executable was detected during upload — this is a hard error, not a simulation fallback
      this.logger.error(
        `Project "${project.name}" has no executablePath recorded. ` +
        `The upload scan did not find a valid .exe in the archive. ` +
        `Ensure your packaged build folder contains the project .exe at its root level.`,
      );
      // Clean up the signaling server we just spawned
      if (signalingProcess && signalingProcess.pid) {
        this.killProcessTree(signalingProcess.pid);
      }
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
    const args = [
      '-RenderOffscreen',
      '-AudioMixer',
      `-PixelStreamingSignallingURL=ws://127.0.0.1:${streamerPort}`,
      `-PixelStreamingIP=127.0.0.1`,
      `-PixelStreamingPort=${streamerPort}`,
      '-PixelStreamingEncoderCodec=H264',
      '-PixelStreamingWebRTCFps=60',
      '-ForceRes',
      '-ResX=1920',
      '-ResY=1080',
      '-Windowed',
    ];
    this.logger.log(`UE launch args: ${args.join(' ')}`);

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
        this.logger.log(`[UE-PID ${ueProcess.pid}] Process exited with code=${code}, signal=${signal}`);
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
        `Ensure the .exe is a valid Windows binary and not corrupted.`,
      );
    }

    // Save processes in memory map
    this.activeProcesses.set(projectId, {
      signalingProcess,
      ueProcess,
      playerPort,
      streamerPort,
      clients: 0,
      idleSeconds: 0,
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
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (isReady) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  // Helper: Poll metrics and enforce auto-stop idle timeouts
  private startMetricsPolling() {
    const axios = require('axios');
    setInterval(async () => {
      for (const [projectId, proc] of this.activeProcesses.entries()) {
        // Query Wilbur's REST API for CCU count
        try {
          const res = await axios.get(`http://127.0.0.1:${proc.playerPort}/status`, { timeout: 1000 });
          if (res.data && typeof res.data.player_count === 'number') {
            proc.clients = res.data.player_count;
          }
        } catch (err) {
          // Ignore polling errors
        }

        // Auto-stop if idle with no connected players
        if (proc.clients === 0) {
          proc.idleSeconds += 3;
          if (proc.idleSeconds >= 60) { // 60 seconds idle timeout
            this.logger.log(`Project ${projectId} has been idle for ${proc.idleSeconds}s. Triggering auto-stop.`);
            try {
              await this.stopInstance(projectId, proc.ownerId);
            } catch (err) {
              this.logger.error(`Failed to auto-stop idle project ${projectId}: ${err.message}`);
            }
          }
        } else {
          proc.idleSeconds = 0;
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
      this.logger.log(`Found ${rootExes.length} executable(s) at root level: ${rootExes.map((e) => path.basename(e)).join(', ')}`);
      const selected = rootExes[0];
      this.logger.log(`Selected root-level executable: ${selected}`);
      return selected;
    }

    this.logger.log('No root-level executable found. Scanning subdirectories (excluding Engine/)...');

    // PASS 2: Recurse into subdirectories but SKIP anything under Engine/
    const subExes = this.findExecutableRecursive(dir, dir);
    if (subExes.length > 0) {
      this.logger.log(`Found ${subExes.length} executable(s) in subdirectories: ${subExes.map((e) => path.relative(dir, e)).join(', ')}`);
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
