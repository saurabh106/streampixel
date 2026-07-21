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
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { GetUser } from '../common/decorators/get-user.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { UserDto } from '../common/types/shared.types';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as fs from 'fs';

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects')
export class ProjectsController {
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
    @Body('version') version: string,
    @GetUser() user: UserDto,
  ) {
    if (!file) {
      throw new BadRequestException('Unreal Engine project ZIP or RAR file is required');
    }
    if (!name || !version) {
      if (file.path && fs.existsSync(file.path)) {
        try {
          fs.unlinkSync(file.path);
        } catch {}
      }
      throw new BadRequestException('Project name and engine version are required');
    }
    return this.projectsService.create(file, name, version, user.id);
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
    return this.projectsService.delete(id, user.id);
  }

  @Post(':id/start')
  @ApiOperation({ summary: 'Start a pixel streaming instance for this project' })
  async startInstance(@Param('id') id: string, @GetUser() user: UserDto) {
    return this.projectsService.startInstance(id, user.id);
  }

  @Post(':id/stop')
  @ApiOperation({ summary: 'Stop the running instance for this project' })
  async stopInstance(@Param('id') id: string, @GetUser() user: UserDto) {
    return this.projectsService.stopInstance(id, user.id);
  }
}
