import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { GetUser } from '../common/decorators/get-user.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { UserDto } from '../common/types/shared.types';
import { diskStorage, memoryStorage } from 'multer';
import * as path from 'path';
import * as fs from 'fs';

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects')
export class ProjectsController {
  private readonly logger = new Logger(ProjectsController.name);
  constructor(private projectsService: ProjectsService) {}

  @Post('upload')
  @ApiOperation({ summary: 'Upload a new Unreal Engine project build (ZIP/RAR)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Packaged UE Project ZIP or RAR archive',
        },
        name: { type: 'string', description: 'Project Name' },
        version: { type: 'string', description: 'Unreal Engine version (e.g. UE 5.4)' },
      },
      required: ['file', 'name', 'version'],
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (req, file, cb) => {
          const storagePath =
            process.env.STORAGE_PATH ||
            (process.platform === 'linux'
              ? '/opt/streampixel/storage'
              : path.resolve(process.cwd(), 'storage'));
          const tempDir = path.join(storagePath, 'tmp');
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
          }
          cb(null, tempDir);
        },
        filename: (req, file, cb) => {
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          cb(null, 'upload-' + uniqueSuffix + path.extname(file.originalname));
        },
      }),
      limits: {
        fileSize: 15 * 1024 * 1024 * 1024, // 15 GB
      },
    }),
  )
  async uploadProject(
    @UploadedFile() file: Express.Multer.File,
    @Body('name') name: string,
    @GetUser() user: UserDto,
  ) {
    if (!file) {
      throw new BadRequestException('Unreal Engine project ZIP or RAR file is required');
    }
    if (!name) {
      if (file.path && fs.existsSync(file.path)) {
        try {
          fs.unlinkSync(file.path);
        } catch {}
      }
      throw new BadRequestException('Project name is required');
    }
    this.logger.log(`[Upload] file=${file?.originalname} size=${file?.size} name="${name}" user=${user.id}`);
    return this.projectsService.create(file, name, user.id);
  }

  @Post('upload/init')
  @ApiOperation({ summary: 'Initialize a chunked upload session' })
  async initUpload(
    @Body('name') name: string,
    @Body('fileName') fileName: string,
    @Body('totalChunks') totalChunks: number,
    @Body('totalSize') totalSize: number,
    @GetUser() user: UserDto,
  ) {
    this.logger.log(`[ChunkedUpload:Init] name="${name}" file="${fileName}" chunks=${totalChunks} size=${totalSize} user=${user.id}`);
    return this.projectsService.initUpload(name, fileName, totalChunks, totalSize, user.id);
  }

  @Post('upload/chunk')
  @ApiOperation({ summary: 'Upload a single chunk of a file' })
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: memoryStorage(),
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  async uploadChunk(
    @UploadedFile() file: Express.Multer.File,
    @Body('sessionId') sessionId: string,
    @Body('chunkIndex') chunkIndex: string,
    @GetUser() user: UserDto,
  ) {
    if (!file) {
      throw new BadRequestException('Chunk data is required');
    }
    if (!sessionId) {
      throw new BadRequestException('Session ID is required');
    }
    const index = parseInt(chunkIndex, 10);
    if (isNaN(index)) {
      throw new BadRequestException('Invalid chunk index');
    }
    this.logger.log(`[ChunkedUpload:Chunk] session=${sessionId} index=${index} chunkSize=${file.buffer.length} user=${user.id}`);
    return this.projectsService.uploadChunk(sessionId, index, file.buffer, user.id);
  }

  @Post('upload/complete')
  @ApiOperation({ summary: 'Complete a chunked upload and process the file' })
  async completeUpload(
    @Body('sessionId') sessionId: string,
    @GetUser() user: UserDto,
  ) {
    if (!sessionId) {
      throw new BadRequestException('Session ID is required');
    }
    this.logger.log(`[ChunkedUpload:Complete] session=${sessionId} user=${user.id}`);
    return this.projectsService.completeUpload(sessionId, user.id);
  }

  @Get('upload/status/:sessionId')
  @ApiOperation({ summary: 'Get upload session status for resume' })
  async getUploadStatus(
    @Param('sessionId') sessionId: string,
    @GetUser() user: UserDto,
  ) {
    this.logger.log(`[ChunkedUpload:Status] session=${sessionId} user=${user.id}`);
    return this.projectsService.getUploadStatus(sessionId, user.id);
  }

  @Get()
  @ApiOperation({ summary: 'List all user projects' })
  async getProjects(@GetUser() user: UserDto) {
    return this.projectsService.findAll(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get project details' })
  async getProject(@Param('id') id: string, @GetUser() user: UserDto) {
    return this.projectsService.findOne(id, user.id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an uploaded project' })
  async deleteProject(@Param('id') id: string, @GetUser() user: UserDto) {
    this.logger.log(`[Delete] project=${id} user=${user.id}`);
    return this.projectsService.delete(id, user.id);
  }

  @Post(':id/start')
  @ApiOperation({ summary: 'Start a pixel streaming instance for this project' })
  async startInstance(@Param('id') id: string, @GetUser() user: UserDto) {
    this.logger.log(`[Start] project=${id} user=${user.id}`);
    return this.projectsService.startInstance(id, user.id);
  }

  @Get(':id/health')
  @ApiOperation({ summary: 'Check health of the running instance for this project' })
  async getInstanceHealth(@Param('id') id: string, @GetUser() user: UserDto) {
    this.logger.log(`[Health] project=${id} user=${user.id}`);
    return this.projectsService.getInstanceHealth(id, user.id);
  }

  @Post(':id/stop')
  @ApiOperation({ summary: 'Stop the running instance for this project' })
  async stopInstance(@Param('id') id: string, @GetUser() user: UserDto) {
    this.logger.log(`[Stop] project=${id} user=${user.id}`);
    return this.projectsService.stopInstance(id, user.id);
  }

  @Post(':id/share-slug')
  @ApiOperation({ summary: 'Generate or get the public share slug for this project' })
  async generateShareSlug(@Param('id') id: string, @GetUser() user: UserDto) {
    this.logger.log(`[ShareSlug] project=${id} user=${user.id}`);
    return this.projectsService.generateShareSlug(id, user.id);
  }
}
