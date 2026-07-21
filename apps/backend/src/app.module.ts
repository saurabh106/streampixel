import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { ProjectsModule } from './projects/projects.module';
import * as path from 'path';
import * as fs from 'fs';

// Helper to locate the root .env file from the monorepo root
function getRootEnvPath(): string {
  let dir = __dirname;
  while (dir && dir !== path.parse(dir).root) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'streampixel-monorepo') {
          return path.join(dir, '.env');
        }
      } catch {}
    }
    if (fs.existsSync(path.join(dir, 'apps')) && fs.existsSync(path.join(dir, 'packages'))) {
      return path.join(dir, '.env');
    }
    dir = path.dirname(dir);
  }
  return path.resolve(process.cwd(), '../../.env');
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: getRootEnvPath(),
    }),
    PrismaModule,
    UsersModule,
    AuthModule,
    ProjectsModule,
  ],
})
export class AppModule {}
