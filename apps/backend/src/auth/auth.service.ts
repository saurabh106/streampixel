import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { UserDto, UserRole } from '@streampixel/shared';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {}

  async register(registerDto: RegisterDto): Promise<UserDto> {
    const user = await this.usersService.create(registerDto);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as unknown as UserRole,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  async login(
    loginDto: LoginDto,
  ): Promise<{ user: UserDto; accessToken: string; refreshToken: string }> {
    const user = await this.usersService.findByEmail(loginDto.email);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordValid = await bcrypt.compare(loginDto.password, user.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const userDto: UserDto = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as unknown as UserRole,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };

    const accessToken = await this.generateAccessToken(user.id, user.email, user.role);
    const refreshToken = await this.generateAndStoreRefreshToken(user.id);

    return { user: userDto, accessToken, refreshToken };
  }

  async logout(refreshTokenString: string): Promise<void> {
    if (!refreshTokenString) return;
    await this.prisma.refreshToken.updateMany({
      where: { token: refreshTokenString },
      data: { isRevoked: true },
    });
  }

  async refreshTokens(
    refreshTokenString: string,
  ): Promise<{ user: UserDto; accessToken: string; refreshToken: string }> {
    if (!refreshTokenString) {
      throw new UnauthorizedException('Refresh token is required');
    }

    const tokenRecord = await this.prisma.refreshToken.findUnique({
      where: { token: refreshTokenString },
      include: { user: true },
    });

    if (!tokenRecord || tokenRecord.isRevoked || new Date() > tokenRecord.expiresAt) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Revoke the current refresh token (rotation strategy)
    await this.prisma.refreshToken.update({
      where: { id: tokenRecord.id },
      data: { isRevoked: true },
    });

    const user = tokenRecord.user;
    const userDto: UserDto = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as unknown as UserRole,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };

    const accessToken = await this.generateAccessToken(user.id, user.email, user.role);
    const newRefreshToken = await this.generateAndStoreRefreshToken(user.id);

    return { user: userDto, accessToken, refreshToken: newRefreshToken };
  }

  private async generateAccessToken(userId: string, email: string, role: string): Promise<string> {
    const payload = { email, role, sub: userId };
    return this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.configService.get<string>('JWT_ACCESS_EXPIRATION', '15m'),
    });
  }

  private async generateAndStoreRefreshToken(userId: string): Promise<string> {
    const token = crypto.randomBytes(40).toString('hex');
    const duration = this.configService.get<string>('JWT_REFRESH_EXPIRATION', '7d');
    const expiresAt = new Date();

    const amount = parseInt(duration);
    const unit = duration.slice(-1);

    if (unit === 'd') {
      expiresAt.setDate(expiresAt.getDate() + amount);
    } else if (unit === 'h') {
      expiresAt.setHours(expiresAt.getHours() + amount);
    } else {
      expiresAt.setDate(expiresAt.getDate() + 7);
    }

    await this.prisma.refreshToken.create({
      data: {
        token,
        userId,
        expiresAt,
      },
    });

    return token;
  }
}
