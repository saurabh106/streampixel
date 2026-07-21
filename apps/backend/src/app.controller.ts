import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Root')
@Controller()
export class AppController {
  @Get()
  @ApiOperation({ summary: 'API Root Status' })
  getRoot() {
    return {
      message: 'Welcome to the StreamPixel API',
      status: 'healthy',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
  }
}
