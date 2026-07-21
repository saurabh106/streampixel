import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);

  // Set Prefix & Cookies
  app.setGlobalPrefix('api/v1', { exclude: ['/'] });
  app.use(cookieParser());

  // Input Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Global Filter and Interceptor
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  // CORS Config
  const corsOrigin = configService.get<string>('CORS_ORIGIN', 'http://localhost:3000');
  app.enableCors({
    origin: corsOrigin.split(','),
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type, Accept, Authorization',
  });

  // OpenAPI Swagger Documentation
  const config = new DocumentBuilder()
    .setTitle('Streampixel SaaS API')
    .setDescription('The API documentation for Streampixel SaaS application (Phase 1 Foundation)')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  // Port and Listen
  const port = configService.get<number>('PORT', 5000);
  await app.listen(port);
  logger.log(`Backend server started on port ${port}`);
  logger.log(`API Documentation available at: http://localhost:${port}/api/docs`);
}
bootstrap();
