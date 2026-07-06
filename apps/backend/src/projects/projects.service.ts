import {
  Injectable,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SignalingServer } from './signaling-server';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';
import { createExtractorFromFile } from 'node-unrar-js';

@Injectable()
export class ProjectsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectsService.name);
  private signalingServers = new Map<string, SignalingServer>(); // projectId -> SignalingServer
  private storagePath = path.resolve(process.cwd(), 'storage');

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    // Ensure storage folders exist
    const projectsDir = path.join(this.storagePath, 'projects');
    if (!fs.existsSync(projectsDir)) {
      fs.mkdirSync(projectsDir, { recursive: true });
      this.logger.log(`Created projects storage directory at ${projectsDir}`);
    }
  }

  async onModuleDestroy() {
    // Clean up all running servers
    this.logger.log('Shutting down. Cleaning up all signaling servers...');
    for (const [projectId, server] of this.signalingServers.entries()) {
      server.close();

      // Try to kill running instance in DB
      try {
        const instance = await this.prisma.instance.findFirst({
          where: { projectId, status: 'RUNNING' },
        });
        if (instance && instance.pid && instance.pid !== 9999) {
          process.kill(instance.pid);
        }
      } catch (e) {
        // ignore
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
    const project = await this.prisma.project.create({
      data: {
        id: projectId,
        name,
        version,
        status: 'STOPPED',
        zipPath,
        extractedPath: projectDir,
        userId,
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
        for (const file of extracted.files) {
          // Iterate generator to write files to disk
        }
      } else {
        this.logger.log(`Extracting project ZIP: ${zipPath}`);
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(projectDir, true);
      }
      this.logger.log(`Extraction complete for ${projectId}`);

      // Search for executable
      const exeFullPath = this.findExecutable(projectDir);
      if (exeFullPath) {
        const relativeExePath = path.relative(projectDir, exeFullPath);
        await this.prisma.project.update({
          where: { id: projectId },
          data: { executablePath: relativeExePath },
        });
        this.logger.log(`Found Unreal Engine executable at relative path: ${relativeExePath}`);
      } else {
        this.logger.warn(
          `No executable (.exe) found in the project archive. Project will run in simulated mode.`,
        );
      }
    } catch (error) {
      this.logger.error(`Failed to extract or scan archive for ${projectId}: ${error.message}`);
      // Don't fail the upload, just log and keep executablePath empty (which falls back to simulation mode)
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

    // Dynamically inject active viewer counts from signaling servers
    return projects.map((p) => {
      const server = this.signalingServers.get(p.id);
      return {
        ...p,
        clients: server ? server.getPlayerCount() : 0,
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

    const server = this.signalingServers.get(project.id);
    return {
      ...project,
      clients: server ? server.getPlayerCount() : 0,
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

    if (existingInstance && this.signalingServers.has(projectId)) {
      return {
        message: 'Instance is already running',
        port: existingInstance.port,
        status: existingInstance.status,
      };
    }

    // Allocate free port starting from 8800
    const port = await this.findFreePort(8800, 8900);
    this.logger.log(`Allocated port ${port} for project ${project.name}`);

    // Create Signaling Server
    const server = new SignalingServer(port);
    this.signalingServers.set(projectId, server);

    let pid = 9999; // Default mock pid for simulation mode

    if (project.executablePath && project.extractedPath) {
      const absoluteExePath = path.resolve(project.extractedPath, project.executablePath);
      if (fs.existsSync(absoluteExePath)) {
        this.logger.log(`Spawning Unreal Engine executable: ${absoluteExePath}`);
        // Unreal Engine Pixel Streaming arguments
        const args = [
          '-AudioMuted',
          `-PixelStreamingURL=ws://127.0.0.1:${port}`,
          '-RenderOffscreen',
          '-ForceRes',
          '-ResX=1280',
          '-ResY=720',
          '-Windowed',
        ];

        try {
          const child = spawn(absoluteExePath, args, {
            cwd: path.dirname(absoluteExePath),
            detached: true,
            stdio: 'ignore',
          });
          child.unref(); // detach from parent
          pid = child.pid || 9999;
          this.logger.log(`Successfully spawned process with PID ${pid}`);
        } catch (err) {
          this.logger.error(
            `Failed to spawn Unreal Engine process: ${err.message}. Falling back to simulation mode.`,
          );
        }
      }
    } else {
      this.logger.log(`No executable path registered. Starting in Simulation Mode.`);
    }

    // Create or update instance record in DB
    await this.prisma.instance.create({
      data: {
        projectId,
        port,
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
      port,
      status: 'RUNNING',
      isSimulated: pid === 9999,
    };
  }

  async stopInstance(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    // Stop signaling server
    const server = this.signalingServers.get(projectId);
    if (server) {
      server.close();
      this.signalingServers.delete(projectId);
    }

    // Find and update instances
    const activeInstances = await this.prisma.instance.findMany({
      where: { projectId, status: 'RUNNING' },
    });

    for (const inst of activeInstances) {
      if (inst.pid && inst.pid !== 9999) {
        this.logger.log(`Killing Unreal process PID ${inst.pid}`);
        try {
          process.kill(inst.pid);
        } catch (e) {
          this.logger.warn(`Could not kill process ${inst.pid}: ${e.message}`);
        }
      }

      await this.prisma.instance.update({
        where: { id: inst.id },
        data: { status: 'STOPPED' },
      });
    }

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

  // Helper: Recursively search for .exe file
  private findExecutable(dir: string): string | null {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch (e) {
        continue;
      }

      if (stat.isDirectory()) {
        const res = this.findExecutable(fullPath);
        if (res) return res;
      } else if (file.endsWith('.exe')) {
        const lowercase = file.toLowerCase();
        // Avoid crash reporters or installers
        if (
          !lowercase.includes('crashreport') &&
          !lowercase.includes('uninstall') &&
          !lowercase.includes('epicgames') &&
          !lowercase.includes('prereq')
        ) {
          return fullPath;
        }
      }
    }
    return null;
  }
}
