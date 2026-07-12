import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Public Projects')
@Controller('public/projects')
export class ProjectsPublicController {
  constructor(private projectsService: ProjectsService) {}

  @Get('share/:shareSlug')
  @ApiOperation({ summary: 'Get or start a shared project instance by slug' })
  async getByShareSlug(@Param('shareSlug') shareSlug: string) {
    return this.projectsService.getByShareSlug(shareSlug);
  }
}
