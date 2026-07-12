import { Controller, Post, Param, Body } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ApiTags, ApiOperation, ApiBody } from '@nestjs/swagger';

@ApiTags('Public Projects')
@Controller('public/projects')
export class ProjectsPublicController {
  constructor(private projectsService: ProjectsService) {}

  @Post('share/:shareSlug')
  @ApiOperation({ summary: 'Get or start a dedicated viewer instance by slug' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        viewerId: { type: 'string', description: 'Unique viewer identifier (UUID)' },
        viewportWidth: { type: 'number', description: 'Browser viewport width in pixels' },
        viewportHeight: { type: 'number', description: 'Browser viewport height in pixels' },
      },
      required: ['viewerId', 'viewportWidth', 'viewportHeight'],
    },
  })
  async getByShareSlug(
    @Param('shareSlug') shareSlug: string,
    @Body('viewerId') viewerId: string,
    @Body('viewportWidth') viewportWidth: number,
    @Body('viewportHeight') viewportHeight: number,
  ) {
    return this.projectsService.getByShareSlug(shareSlug, viewerId, viewportWidth, viewportHeight);
  }

  @Post('share/:shareSlug/stop')
  @ApiOperation({ summary: 'Stop a specific viewer instance (viewer disconnect)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        viewerId: { type: 'string', description: 'The viewer identifier to stop' },
      },
      required: ['viewerId'],
    },
  })
  async stopViewerInstance(
    @Param('shareSlug') shareSlug: string,
    @Body('viewerId') viewerId: string,
  ) {
    const project = await this.projectsService.findProjectByShareSlug(shareSlug);
    return this.projectsService.stopViewerInstance(project.id, viewerId);
  }
}
